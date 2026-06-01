import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ClaudeSession } from "./claude.js";
import type { Config } from "./config.js";
import { buildBranchName, buildWorktreePath, Git } from "./git.js";
import type { Logger } from "./logger.js";
import { parsePlanPhases, type ParsedPhase } from "./plan.js";
import {
  hasAcceptanceCriteria,
  injectAutodraftedAc,
} from "./planeDescription.js";
import type { PlaneApi, PlaneIssue } from "./plane.js";
import { buildPlanningPrompt } from "./prompts/planning.js";
import type { Store } from "./store.js";

export interface PlanOptions {
  /** 1-indexed pipeline loop number. 1 = fresh plan, 2+ = revision. */
  loopNumber?: number;
  /** Notes from prior E2E failures, fed to the planning prompt as revision context. */
  priorFailures?: string;
  /** Optional abort signal for reviewer-feedback interruption. */
  signal?: AbortSignal;
}

export interface PlanResult {
  branch: string;
  worktreePath: string;
  planPath: string;
  phaseTitles: string[];
  /** Phase 6.5: parsed phases (index/title/satisfiesAc) for the dashboard. */
  phases: ParsedPhase[];
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
    const memoryAbsPath = join(issueDir, "memory.md");
    const doneFlagAbsPath = join(issueDir, "done.flag");
    const acDraftAbsPath = join(issueDir, "ac-draft.md");

    // If a previous run left these around, clear them so we get a fresh
    // signal.
    for (const p of [planAbsPath, doneFlagAbsPath, acDraftAbsPath]) {
      if (existsSync(p)) {
        await rm(p);
      }
    }

    const shortId = `PLANE-${issue.sequenceId}`;
    const planRelPath = relative(worktreePath, planAbsPath);
    const memoryRelPath = relative(worktreePath, memoryAbsPath);
    const doneFlagRelPath = relative(worktreePath, doneFlagAbsPath);
    const acDraftRelPath = relative(worktreePath, acDraftAbsPath);

    // Phase 6.5: only the human-authored section counts as "already has AC".
    // On retry loops the auto-drafted section is already part of the
    // description text, so this naturally returns true and we don't re-draft.
    const acAlreadyPresent = hasAcceptanceCriteria(detail.descriptionText);

    const prompt = buildPlanningPrompt({
      workItemId: issue.id,
      shortId,
      sequenceId: issue.sequenceId,
      title: issue.name,
      descriptionText: detail.descriptionText,
      planRelPath,
      doneFlagRelPath,
      memoryRelPath,
      branch,
      loopNumber: opts.loopNumber ?? 1,
      priorFailures: opts.priorFailures ?? "",
      hasAcceptanceCriteria: acAlreadyPresent,
      acDraftRelPath,
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
      signal: opts.signal,
    });

    this.store.recordEvent(issue.id, "claude_session_finished", {
      exitCode: result.exitCode,
      signal: result.signal,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
      aborted: result.aborted,
    });

    if (result.aborted) {
      throw new PlanningAbortedError(
        "planning session aborted for reviewer feedback",
        { worktreePath, branch, transcript: result.transcript },
      );
    }

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

    // Phase 6.5: the agent signals an un-plannable issue via `too-vague`.
    const verdict = (await readFlag(doneFlagAbsPath)).trim().split(/\s+/)[0] ?? "";
    if (verdict === "too-vague") {
      this.store.recordEvent(issue.id, "planning_too_vague", {
        loopNumber: opts.loopNumber ?? 1,
      });
      throw new PlanningTooVagueError(
        "issue description is too vague to extract acceptance criteria",
        { worktreePath, branch, transcript: result.transcript },
      );
    }

    if (!existsSync(planAbsPath)) {
      throw new PlanningError(
        `planning agent did not write expected plan file at ${planRelPath}`,
        { worktreePath, branch, transcript: result.transcript },
      );
    }

    const planMarkdown = await readFile(planAbsPath, "utf8");
    const phases = parsePlanPhases(planMarkdown);
    const phaseTitles = phases.map((p) => p.title);
    if (phases.length === 0) {
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

    // Phase 6.5: if the issue had no human AC and the agent drafted some,
    // inject them above the fence (with a provenance sentinel). The orchestrator
    // owns the dashboard fence itself, so the planner no longer dumps the plan
    // into the description. injectAutodraftedAc is a no-op once the sentinel
    // exists, so retry loops never re-stomp it.
    if (!acAlreadyPresent) {
      const acItems = await readAcDraft(acDraftAbsPath);
      if (acItems.length > 0) {
        try {
          const refreshed = await this.plane.retrieveIssue(issue.id);
          const newHtml = injectAutodraftedAc(
            refreshed.descriptionHtml ?? "",
            acItems,
          );
          if (newHtml !== (refreshed.descriptionHtml ?? "")) {
            await this.plane.updateDescriptionHtml(issue.id, newHtml);
            this.store.recordEvent(issue.id, "ac_autodrafted", {
              count: acItems.length,
              loopNumber: opts.loopNumber ?? 1,
            });
          }
        } catch (err) {
          this.logger.warn(
            { err, workItemId: issue.id },
            "failed to inject auto-drafted acceptance criteria (continuing)",
          );
          this.store.recordEvent(issue.id, "ac_autodraft_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const planComment = await this.plane.postComment(
      issue.id,
      buildPlanCommentHtml({
        branch,
        phaseTitles,
        planRelPath: planPathRecord,
        headSha,
        loopNumber: opts.loopNumber ?? 1,
      }),
    );
    this.store.advanceCommentWatermark(issue.id, planComment.createdAt);

    return {
      branch,
      worktreePath,
      planPath: planPathRecord,
      phaseTitles,
      phases,
      headSha,
    };
  }
}

/** Read the done.flag verdict, tolerating a missing file. */
async function readFlag(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Parse the planner's `ac-draft.md` into bullet texts. Accepts `- [ ] foo`,
 * `* foo`, or plain `- foo` lines; ignores headings / blank lines. Caps at 5
 * (the PRD's draft ceiling) so a runaway draft can't flood the description.
 */
async function readAcDraft(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const items: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (m && m[1] && m[1].trim().length > 0) items.push(m[1].trim());
  }
  return items.slice(0, 5);
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
 * Phase 6.5: thrown when the issue has no Acceptance Criteria and the
 * description is too thin to draft any. The orchestrator handles this
 * distinctly from a generic PlanningError — it posts a "please add ACs"
 * comment and does not loop.
 */
export class PlanningTooVagueError extends Error {
  constructor(
    message: string,
    public readonly details: {
      worktreePath: string;
      branch: string;
      transcript: string;
    },
  ) {
    super(message);
    this.name = "PlanningTooVagueError";
  }
}

/**
 * Thrown when the planning session was interrupted by reviewer feedback. The
 * orchestrator treats this differently from PlanningError: it drains pending
 * feedback and re-enters the planning stage with the comment text included.
 */
export class PlanningAbortedError extends Error {
  constructor(
    message: string,
    public readonly details: {
      worktreePath: string;
      branch: string;
      transcript: string;
    },
  ) {
    super(message);
    this.name = "PlanningAbortedError";
  }
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

