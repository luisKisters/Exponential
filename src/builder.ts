import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { ClaudeSession, type ClaudeSessionResult } from "./claude.js";
import type { Config } from "./config.js";
import { startDevServer, type DevServerHandle } from "./devServer.js";
import { Git } from "./git.js";
import type { Logger } from "./logger.js";
import {
  injectPlanFence,
  tickAcceptanceCriteria,
  type TickResult,
} from "./planeDescription.js";
import type { PlaneApi, PlaneIssueDetail } from "./plane.js";
import { findAvailablePort } from "./ports.js";
import { buildBuildingPrompt } from "./prompts/building.js";
import type { Store } from "./store.js";

export interface BuildInput {
  /** Plane work item (already retrieved with description). */
  issue: PlaneIssueDetail;
  /** Result of the planning phase. */
  branch: string;
  worktreePath: string;
  planRelPath: string;
  /** Optional abort signal for reviewer-feedback interruption. */
  signal?: AbortSignal;
}

export interface BuildResult {
  /** True if the agent reported all phases complete. */
  ok: boolean;
  attempts: number;
  /** Final HEAD sha pushed to remote (or null if nothing was pushed). */
  headSha: string | null;
  /** Phase outcomes parsed from progress.md. */
  phases: PhaseOutcome[];
  /** AC ticking result against the Plane description. */
  tickResult: TickResult | null;
  /** True if the build was interrupted by reviewer feedback. */
  aborted: boolean;
}

export interface PhaseOutcome {
  index: number;
  title: string;
  status: "complete" | "failed";
  attempts: number;
  satisfiesAc: number[];
  browserCheck: "passed" | "skipped" | "failed" | "unknown";
  notes: string;
}

export class BuildingError extends Error {
  constructor(
    message: string,
    public readonly details: {
      worktreePath: string;
      branch: string;
      transcript: string;
    },
  ) {
    super(message);
    this.name = "BuildingError";
  }
}

export class Builder {
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

  async build(input: BuildInput): Promise<BuildResult> {
    const { issue, branch, worktreePath, planRelPath, signal } = input;
    const shortId = `PLANE-${issue.sequenceId}`;

    this.store.markBuilding(issue.id);
    this.store.recordEvent(issue.id, "building_started", {
      branch,
      worktreePath,
    });

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const progressAbs = join(issueDir, "progress.md");
    const failuresAbs = join(issueDir, "failures.md");
    const summaryAbs = join(issueDir, "summary.md");
    const doneFlagAbs = join(issueDir, "done.flag");

    // Fresh signal: clear the done flag from any previous run. Keep progress
    // and failures around — the agent can read its own history.
    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

    // Best-effort: link .env and node_modules from the source repo into the
    // worktree so `pnpm build` / `pnpm dev` can run without a fresh install.
    await linkRepoArtifacts(this.logger, {
      sourceRepo: this.config.summario.repoPath,
      worktreePath,
    });

    // Optionally start a dev server. We treat this as best-effort: if it
    // doesn't come up, the agent is told it's unavailable and falls back to
    // build-only verification.
    let devServer: DevServerHandle | null = null;
    if (this.config.builder.devServer !== "off") {
      try {
        const port = await findAvailablePort(this.config.builder.devServerBasePort);
        devServer = await startDevServer(this.logger, {
          cwd: worktreePath,
          port,
        });
        this.store.recordEvent(issue.id, "dev_server_ready", {
          port: devServer.port,
          url: devServer.url,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          { err, worktreePath },
          "dev server failed to start; continuing without it",
        );
        this.store.recordEvent(issue.id, "dev_server_failed", {
          error: message,
        });
        if (this.config.builder.devServer === "required") {
          throw new BuildingError(
            `dev server required but failed to start: ${message}`,
            { worktreePath, branch, transcript: "" },
          );
        }
      }
    }

    let attempt = 0;
    let lastResult: ClaudeSessionResult | null = null;
    let priorFailures = "";
    let ok = false;

    try {
      while (attempt < this.config.builder.maxAttempts) {
        attempt++;
        const prompt = buildBuildingPrompt({
          workItemId: issue.id,
          shortId,
          sequenceId: issue.sequenceId,
          title: issue.name,
          descriptionText: issue.descriptionText,
          branch,
          planRelPath,
          progressRelPath: relative(worktreePath, progressAbs),
          failuresRelPath: relative(worktreePath, failuresAbs),
          doneFlagRelPath: relative(worktreePath, doneFlagAbs),
          summaryRelPath: relative(worktreePath, summaryAbs),
          devServerUrl: devServer?.url ?? null,
          attemptNumber: attempt,
          priorFailures,
        });

        this.store.recordEvent(issue.id, "build_attempt_started", {
          attempt,
          promptLength: prompt.length,
        });

        lastResult = await this.claude.run({
          cwd: worktreePath,
          prompt,
          doneFlagPath: doneFlagAbs,
          timeoutMs: this.config.claude.timeoutMs,
          binary: this.config.claude.binary,
          extraArgs: this.config.claude.extraArgs,
          signal,
        });

        this.store.recordEvent(issue.id, "build_attempt_finished", {
          attempt,
          exitCode: lastResult.exitCode,
          signal: lastResult.signal,
          doneFlagSeen: lastResult.doneFlagSeen,
          timedOut: lastResult.timedOut,
          aborted: lastResult.aborted,
        });

        // Reviewer interrupted us — stop the retry loop immediately so the
        // orchestrator can re-plan with the feedback included.
        if (lastResult.aborted) break;

        const flagContent = await safeRead(doneFlagAbs);
        const verdict = (flagContent ?? "").trim().split(/\s+/)[0] ?? "";

        if (lastResult.doneFlagSeen && verdict === "build-ok") {
          ok = true;
          break;
        }

        const failuresSoFar = await safeRead(failuresAbs);
        const progressSoFar = await safeRead(progressAbs);
        priorFailures = `## Attempt ${attempt} (${verdict || "no-verdict"})\n\nfailures.md so far:\n\n${(failuresSoFar ?? "(empty)").slice(0, 8_000)}\n\nprogress.md so far:\n\n${(progressSoFar ?? "(empty)").slice(0, 8_000)}`;

        // Tear down done.flag so the next iteration starts cleanly.
        if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

        if (attempt >= this.config.builder.maxAttempts) break;
        this.logger.warn(
          { workItemId: issue.id, attempt, verdict },
          "build attempt failed, retrying",
        );
      }
    } finally {
      if (devServer) {
        try {
          await devServer.stop();
          this.store.recordEvent(issue.id, "dev_server_stopped", {
            port: devServer.port,
          });
        } catch (err) {
          this.logger.warn({ err }, "failed to stop dev server cleanly");
        }
      }
    }

    const aborted = lastResult?.aborted === true;
    if (aborted) {
      // Don't post a build comment, don't push, don't mark build failed.
      // The orchestrator will re-plan with reviewer feedback included.
      this.store.recordEvent(issue.id, "build_aborted_for_feedback", {
        attempts: attempt,
      });
      // Clean up the done.flag if it was left around (mid-write).
      if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);
      return {
        ok: false,
        attempts: attempt,
        headSha: null,
        phases: [],
        tickResult: null,
        aborted: true,
      };
    }

    const finalProgress = (await safeRead(progressAbs)) ?? "";
    const planMarkdown = (await safeRead(
      join(this.config.summario.repoPath, planRelPath),
    )) ?? (await safeRead(join(worktreePath, planRelPath))) ?? "";
    const phases = parseProgress(finalProgress);

    // Commit any leftover agent files (progress.md, failures.md, summary.md).
    // done.flag is removed before commit so it doesn't leak into history.
    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);
    const committedAgentFiles = await this.git.commitAll(
      worktreePath,
      `chore(build): record progress for PLANE-${issue.sequenceId}`,
    );

    const headSha = await this.git.headSha(worktreePath);

    // Sync Plane description: inject plan inside fence and tick satisfied ACs.
    let tickResult: TickResult | null = null;
    try {
      tickResult = await this.syncPlaneDescription(issue.id, planMarkdown, phases);
    } catch (err) {
      this.logger.warn(
        { err, workItemId: issue.id },
        "failed to sync plane description",
      );
      this.store.recordEvent(issue.id, "description_sync_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Push whatever we have. Even partial success is worth pushing for review.
    let pushedSha: string | null = null;
    try {
      await this.git.push(
        worktreePath,
        this.config.summario.remoteName,
        branch,
      );
      pushedSha = headSha;
      this.store.recordEvent(issue.id, "build_branch_pushed", {
        branch,
        headSha,
        committedAgentFiles,
      });
    } catch (err) {
      this.logger.error({ err, branch }, "git push failed");
      this.store.recordEvent(issue.id, "build_push_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Final Plane comment.
    try {
      const buildComment = await this.plane.postComment(
        issue.id,
        buildResultCommentHtml({
          ok,
          attempts: attempt,
          phases,
          branch,
          headSha: pushedSha,
          tickResult,
        }),
      );
      this.store.advanceCommentWatermark(issue.id, buildComment.createdAt);
    } catch (err) {
      this.logger.error(
        { err, workItemId: issue.id },
        "failed to post build comment",
      );
    }

    if (ok) {
      this.store.markBuilt(issue.id, {
        summaryPath: relative(this.config.summario.repoPath, summaryAbs),
        headSha: pushedSha,
      });
    } else {
      const transcript = lastResult?.transcript ?? "";
      const reason = !lastResult?.doneFlagSeen
        ? "no done.flag (timeout or crash)"
        : "agent reported build-failed";
      this.store.markBuildFailed(
        issue.id,
        `building agent did not complete cleanly after ${attempt} attempt(s): ${reason}`,
      );
      this.store.recordEvent(issue.id, "building_failed", {
        attempts: attempt,
        reason,
        transcriptTail: transcript.slice(-2_000),
      });
    }

    return {
      ok,
      attempts: attempt,
      headSha: pushedSha,
      phases,
      tickResult,
      aborted: false,
    };
  }

  private async syncPlaneDescription(
    workItemId: string,
    planMarkdown: string,
    phases: PhaseOutcome[],
  ): Promise<TickResult> {
    const detail = await this.plane.retrieveIssue(workItemId);
    const currentHtml = detail.descriptionHtml ?? "";

    const withPlan = injectPlanFence(currentHtml, planMarkdown);

    const satisfied = new Set<number>();
    for (const phase of phases) {
      if (phase.status !== "complete") continue;
      for (const ac of phase.satisfiesAc) satisfied.add(ac);
    }
    const indices = [...satisfied].sort((a, b) => a - b);

    const tickResult = tickAcceptanceCriteria(withPlan, indices);
    await this.plane.updateDescriptionHtml(workItemId, tickResult.html);

    if (tickResult.skipped.length > 0) {
      this.logger.warn(
        { workItemId, skipped: tickResult.skipped, format: tickResult.format },
        "some AC indices did not match a checkbox in the plane description",
      );
    }
    this.store.recordEvent(workItemId, "description_synced", {
      matchedAc: tickResult.matched,
      skippedAc: tickResult.skipped,
      format: tickResult.format,
    });

    return tickResult;
  }
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function linkRepoArtifacts(
  logger: Logger,
  input: { sourceRepo: string; worktreePath: string },
): Promise<void> {
  const candidates = [".env", ".env.local", "node_modules"];
  for (const name of candidates) {
    const source = join(input.sourceRepo, name);
    const target = join(input.worktreePath, name);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      await symlink(source, target, name === "node_modules" ? "dir" : "file");
      logger.debug({ source, target }, "symlinked repo artifact into worktree");
    } catch (err) {
      logger.warn(
        { err, name },
        "failed to symlink repo artifact into worktree; continuing",
      );
    }
  }
}

const PHASE_HEADING_RE = /^##\s+Phase\s+(\d+)\s*[—:\-]\s*(.+?)\s*$/gim;

/**
 * Parse the agent's progress.md into structured phase outcomes.
 *
 * The agent is asked to write blocks of the form:
 *
 *   ## Phase N — title
 *   - Status: complete | failed
 *   - Attempts: 2
 *   - Satisfies AC: 1, 3
 *   - Browser check: passed | skipped | failed
 *   - Notes: ...
 *
 * We're lenient: unknown lines are skipped, missing fields default to safe
 * "unknown" / empty values, and the parser walks heading-by-heading so a
 * malformed block doesn't break the rest.
 */
export function parseProgress(progressMd: string): PhaseOutcome[] {
  const headings: Array<{ index: number; title: string; start: number; end: number }> = [];
  const matches = [...progressMd.matchAll(PHASE_HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const next = matches[i + 1];
    headings.push({
      index: Number(m[1]!),
      title: m[2]!.trim(),
      start: (m.index ?? 0) + m[0].length,
      end: next?.index ?? progressMd.length,
    });
  }

  const outcomes: PhaseOutcome[] = [];
  for (const h of headings) {
    const body = progressMd.slice(h.start, h.end);
    const status = matchField(body, "Status");
    const attemptsStr = matchField(body, "Attempts");
    const satisfies = matchField(body, "Satisfies AC");
    const browserCheck = matchField(body, "Browser check");
    const notes = matchField(body, "Notes") ?? "";

    outcomes.push({
      index: h.index,
      title: h.title,
      status: status === "complete" ? "complete" : "failed",
      attempts: attemptsStr ? Number.parseInt(attemptsStr, 10) || 1 : 1,
      satisfiesAc: parseAcList(satisfies),
      browserCheck: parseBrowserCheck(browserCheck),
      notes,
    });
  }
  return outcomes;
}

function matchField(body: string, label: string): string | null {
  const re = new RegExp(
    `^\\s*[-*]\\s+${escapeRe(label)}\\s*:\\s*(.+?)\\s*$`,
    "im",
  );
  const m = re.exec(body);
  return m ? m[1]!.trim() : null;
}

function escapeRe(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAcList(raw: string | null): number[] {
  if (!raw) return [];
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "none" || trimmed === "n/a") return [];
  return trimmed
    .split(/[,\s]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseBrowserCheck(raw: string | null): PhaseOutcome["browserCheck"] {
  if (!raw) return "unknown";
  const t = raw.trim().toLowerCase();
  if (t.startsWith("pass")) return "passed";
  if (t.startsWith("fail")) return "failed";
  if (t.startsWith("skip")) return "skipped";
  return "unknown";
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildResultCommentHtml(input: {
  ok: boolean;
  attempts: number;
  phases: PhaseOutcome[];
  branch: string;
  headSha: string | null;
  tickResult: TickResult | null;
}): string {
  const verdict = input.ok
    ? "<strong>Build succeeded.</strong>"
    : "<strong>Build did not complete.</strong>";

  const phaseList = input.phases.length === 0
    ? "<p><em>No phase entries recorded in progress.md.</em></p>"
    : `<ol>${input.phases
        .map((p) =>
          `<li>Phase ${p.index} — ${escapeHtml(p.title)} — <code>${p.status}</code>${
            p.satisfiesAc.length > 0
              ? ` (AC ${p.satisfiesAc.join(", ")})`
              : ""
          }${p.notes ? `: ${escapeHtml(p.notes)}` : ""}</li>`,
        )
        .join("")}</ol>`;

  const sha = input.headSha
    ? `<br>Commit: <code>${escapeHtml(input.headSha.slice(0, 12))}</code>`
    : "<br><em>Branch was not pushed.</em>";

  const tickLine = input.tickResult
    ? `<p>Acceptance criteria ticked: ${
        input.tickResult.matched.length > 0
          ? input.tickResult.matched.map((i) => `#${i}`).join(", ")
          : "none"
      }${
        input.tickResult.skipped.length > 0
          ? ` (skipped: ${input.tickResult.skipped.map((i) => `#${i}`).join(", ")})`
          : ""
      }</p>`
    : "";

  return `<p>${verdict} Attempts: ${input.attempts}.</p>
<p>Branch: <code>${escapeHtml(input.branch)}</code>${sha}</p>
${phaseList}
${tickLine}`;
}
