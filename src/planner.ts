import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ClaudeSession } from "./claude.js";
import type { Config } from "./config.js";
import { buildBranchName, buildWorktreePath, Git } from "./git.js";
import type { Logger } from "./logger.js";
import { injectPlanFence } from "./planeDescription.js";
import type { PlaneApi, PlaneIssue } from "./plane.js";
import { buildPlanningPrompt } from "./prompts/planning.js";
import type { Store } from "./store.js";

export interface PlanOptions {
  /** 1-indexed pipeline loop number. 1 = fresh plan, 2+ = revision. */
  loopNumber?: number;
  /** Notes from prior E2E failures, fed to the planning prompt as revision context. */
  priorFailures?: string;
}

export interface PlanResult {
  branch: string;
  worktreePath: string;
  planPath: string;
  phaseTitles: string[];
  /** Sha that was pushed to the remote. */
  headSha: string;
}

export class Planner {
  private readonly git: Git;
  private readonly claude: ClaudeSession;

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly plane: PlaneApi,
    private readonly store: Store,
  ) {
    this.git = new Git(logger, config.summario.repoPath);
    this.claude = new ClaudeSession(logger);
  }

  async ensureReady(): Promise<void> {
    await this.git.ensureRepo();
  }

  /**
   * Run the planning workflow for an issue. Throws on failure; the caller is
   * responsible for updating store + Plane on the failure path.
   */
  async plan(issue: PlaneIssue, opts: PlanOptions = {}): Promise<PlanResult> {
    const detail = await this.plane.retrieveIssue(issue.id);

    const branch = buildBranchName(issue.sequenceId, issue.name);
    const worktreePath = buildWorktreePath(
      this.config.summario.worktreeBasePath,
      issue.sequenceId,
    );

    this.logger.info(
      {
        workItemId: issue.id,
        sequenceId: issue.sequenceId,
        branch,
        worktreePath,
      },
      "preparing planning worktree",
    );

    this.store.markPlanning(issue.id, { branch, worktreePath });
    this.store.recordEvent(issue.id, "planning_started", {
      branch,
      worktreePath,
    });

    await this.git.fetch(this.config.summario.remoteName);
    await this.git.addWorktree(
      worktreePath,
      branch,
      this.config.summario.defaultBranch,
      this.config.summario.remoteName,
    );

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const planAbsPath = join(issueDir, "plan.md");
    const progressAbsPath = join(issueDir, "progress.md");
    const doneFlagAbsPath = join(issueDir, "done.flag");

    // If a previous run left these around, clear them so we get a fresh
    // signal.
    for (const p of [planAbsPath, doneFlagAbsPath]) {
      if (existsSync(p)) {
        await rm(p);
      }
    }

    const shortId = `PLANE-${issue.sequenceId}`;
    const planRelPath = relative(worktreePath, planAbsPath);
    const progressRelPath = relative(worktreePath, progressAbsPath);
    const doneFlagRelPath = relative(worktreePath, doneFlagAbsPath);

    const prompt = buildPlanningPrompt({
      workItemId: issue.id,
      shortId,
      sequenceId: issue.sequenceId,
      title: issue.name,
      descriptionText: detail.descriptionText,
      planRelPath,
      doneFlagRelPath,
      progressRelPath,
      branch,
      loopNumber: opts.loopNumber ?? 1,
      priorFailures: opts.priorFailures ?? "",
    });

    this.store.recordEvent(issue.id, "claude_session_started", {
      promptLength: prompt.length,
    });

    const result = await this.claude.run({
      cwd: worktreePath,
      prompt,
      doneFlagPath: doneFlagAbsPath,
      timeoutMs: this.config.claude.timeoutMs,
      binary: this.config.claude.binary,
      extraArgs: this.config.claude.extraArgs,
    });

    this.store.recordEvent(issue.id, "claude_session_finished", {
      exitCode: result.exitCode,
      signal: result.signal,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
    });

    if (!result.doneFlagSeen) {
      const reason = result.timedOut
        ? `claude session timed out after ${this.config.claude.timeoutMs}ms`
        : `claude exited (code=${result.exitCode}, signal=${result.signal}) before writing done.flag`;
      throw new PlanningError(reason, {
        worktreePath,
        branch,
        transcript: result.transcript,
      });
    }

    if (!existsSync(planAbsPath)) {
      throw new PlanningError(
        `planning agent did not write expected plan file at ${planRelPath}`,
        { worktreePath, branch, transcript: result.transcript },
      );
    }

    const planMarkdown = await readFile(planAbsPath, "utf8");
    const phaseTitles = extractPhaseTitles(planMarkdown);
    if (phaseTitles.length === 0) {
      throw new PlanningError(
        `plan.md exists but contains no recognisable "## Phase N" headings`,
        { worktreePath, branch, transcript: result.transcript },
      );
    }

    // Remove the done.flag so it is not committed.
    if (existsSync(doneFlagAbsPath)) {
      await rm(doneFlagAbsPath);
    }

    const commitMessage = `chore(plan): add plan for ${shortId} — ${truncate(issue.name, 60)}\n\nPhases:\n${phaseTitles.map((t) => `- ${t}`).join("\n")}\n`;
    const committed = await this.git.commitAll(worktreePath, commitMessage);
    if (!committed) {
      throw new PlanningError(
        "git working tree had no changes to commit (plan.md not staged?)",
        { worktreePath, branch, transcript: result.transcript },
      );
    }

    const headSha = await this.git.headSha(worktreePath);

    await this.git.push(
      worktreePath,
      this.config.summario.remoteName,
      branch,
    );

    const planPathRecord = relative(this.config.summario.repoPath, planAbsPath);
    this.store.markPlanned(issue.id, planPathRecord);
    this.store.recordEvent(issue.id, "planning_complete", {
      branch,
      headSha,
      planPath: planPathRecord,
      phases: phaseTitles.length,
    });

    // Inject the plan into the Plane description fence. This makes the
    // revised plan visible above the comment stream — important after retries
    // (Phase 4 loops back here with a revised plan).
    try {
      const refreshed = await this.plane.retrieveIssue(issue.id);
      const newHtml = injectPlanFence(refreshed.descriptionHtml ?? "", planMarkdown);
      await this.plane.updateDescriptionHtml(issue.id, newHtml);
      this.store.recordEvent(issue.id, "plan_fence_synced", {
        loopNumber: opts.loopNumber ?? 1,
      });
    } catch (err) {
      this.logger.warn(
        { err, workItemId: issue.id },
        "failed to sync plan into Plane description (continuing)",
      );
      this.store.recordEvent(issue.id, "plan_fence_sync_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await this.plane.postComment(
      issue.id,
      buildPlanCommentHtml({
        branch,
        phaseTitles,
        planRelPath: planPathRecord,
        headSha,
        loopNumber: opts.loopNumber ?? 1,
      }),
    );

    return {
      branch,
      worktreePath,
      planPath: planPathRecord,
      phaseTitles,
      headSha,
    };
  }
}

export class PlanningError extends Error {
  constructor(
    message: string,
    public readonly details: {
      worktreePath: string;
      branch: string;
      transcript: string;
    },
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

/**
 * Extract "## Phase N — title" headings (or "## Phase N: title") from the
 * generated plan.
 */
export function extractPhaseTitles(markdown: string): string[] {
  const titles: string[] = [];
  const re = /^##\s+Phase\s+\d+\s*[—:\-]\s*(.+?)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    titles.push(match[1]!.trim());
  }
  return titles;
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPlanCommentHtml(input: {
  branch: string;
  phaseTitles: string[];
  planRelPath: string;
  headSha: string;
  loopNumber: number;
}): string {
  const items = input.phaseTitles
    .map((title, i) => `<li>Phase ${i + 1}: ${escapeHtml(title)}</li>`)
    .join("");
  const heading = input.loopNumber > 1
    ? `<p><strong>Planning revised (loop ${input.loopNumber}).</strong></p>`
    : `<p><strong>Planning complete.</strong></p>`;
  return `${heading}
<p>Branch: <code>${escapeHtml(input.branch)}</code><br>Plan: <code>${escapeHtml(input.planRelPath)}</code><br>Commit: <code>${escapeHtml(input.headSha.slice(0, 12))}</code></p>
<ol>${items}</ol>`;
}

