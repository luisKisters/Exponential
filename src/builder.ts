import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ClaudeSession } from "./claude.js";
import type { Config } from "./config.js";
import { Git } from "./git.js";
import type { Logger } from "./logger.js";
import { appendMemorySection, ensureMemoryFile, formatPhaseSection } from "./memory.js";
import { parseAcList, parsePlanPhases } from "./plan.js";
import {
  tickAcceptanceCriteria,
  type TickResult,
} from "./planeDescription.js";
import type { PlaneApi, PlaneIssueDetail } from "./plane.js";
import { runPnpmBuild } from "./pnpm.js";
import { buildPhasePrompt } from "./prompts/buildPhase.js";
import { buildFixupPrompt } from "./prompts/buildFixup.js";
import type { Store } from "./store.js";

/**
 * Phase 6.5: per-phase progress event the builder emits so the orchestrator can
 * keep the live dashboard fence in sync as each phase starts / finishes.
 */
export type PhaseProgressEvent =
  | { type: "phase_start"; index: number; total: number; title: string }
  | { type: "phase_complete"; index: number }
  | { type: "phase_failed"; index: number };

export interface BuildInput {
  /** Plane work item (already retrieved with description). */
  issue: PlaneIssueDetail;
  /** Result of the planning phase. */
  branch: string;
  worktreePath: string;
  planRelPath: string;
  /** Optional abort signal for reviewer-feedback interruption. */
  signal?: AbortSignal;
  /** Phase 6.5: dashboard progress callback (best-effort; errors are swallowed). */
  onProgress?: (event: PhaseProgressEvent) => Promise<void> | void;
}

export interface BuildResult {
  /** True if every plan phase completed. */
  ok: boolean;
  /** Total per-phase Claude sessions spawned across all phases. */
  attempts: number;
  /** Final HEAD sha pushed to remote (or null if nothing was pushed). */
  headSha: string | null;
  /** Per-phase outcomes (one entry per phase the build stage reached). */
  phases: PhaseOutcome[];
  /** AC ticking result against the Plane description. */
  tickResult: TickResult | null;
  /** True if the build was interrupted by reviewer feedback. */
  aborted: boolean;
}

export interface FixupInput {
  issue: PlaneIssueDetail;
  branch: string;
  worktreePath: string;
  planRelPath: string;
  /** Vercel deployment URL whose build failed. */
  previewUrl: string;
  /** Captured build log (tail). */
  buildLog: string;
  /** 1-indexed fixup attempt number. */
  attemptNumber: number;
  /** Accumulated notes from prior fixup attempts (empty for attempt 1). */
  priorFailures: string;
  /** Optional abort signal for reviewer-feedback interruption. */
  signal?: AbortSignal;
}

export interface FixupResult {
  /** True if the agent reported fixup-ok AND advanced HEAD. */
  ok: boolean;
  /** True if Claude reported done.flag at all. */
  doneFlagSeen: boolean;
  /** True if reviewer feedback aborted the session mid-flight. */
  aborted: boolean;
  /** Verdict word read from done.flag (`fixup-ok` | `fixup-failed` | other). */
  verdict: string;
  /** HEAD sha after the session (and orchestrator's leftover-files commit). */
  newHeadSha: string;
  /** True if `newHeadSha` differs from the pre-fixup sha. */
  advancedHead: boolean;
  /** Pushed-to-remote sha (or null if push failed / nothing to push). */
  pushedSha: string | null;
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

  /**
   * Phase 6: implement the plan one phase at a time, each in its own fresh
   * Claude session sharing state through memory.md. The orchestrator (not the
   * agent) runs the authoritative `pnpm build`, writes the uniform per-phase
   * memory section, and commits each phase. A failed phase is retried in a
   * fresh session up to PHASE_MAX_ATTEMPTS; if it still fails the build stage
   * stops (later phases are not started).
   */
  async build(input: BuildInput): Promise<BuildResult> {
    const { issue, branch, worktreePath, planRelPath, signal, onProgress } = input;
    const shortId = `PLANE-${issue.sequenceId}`;
    const emitProgress = async (event: PhaseProgressEvent): Promise<void> => {
      try {
        await onProgress?.(event);
      } catch (err) {
        this.logger.warn({ err, event }, "phase progress callback threw");
      }
    };

    this.store.markBuilding(issue.id);
    this.store.recordEvent(issue.id, "building_started", { branch, worktreePath });

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const memoryAbs = join(issueDir, "memory.md");
    const summaryAbs = join(issueDir, "summary.md");
    const doneFlagAbs = join(issueDir, "done.flag");
    const reportAbs = join(issueDir, "phase-report.md");

    // Clear transient signals from any previous run. memory.md persists — it's
    // the cross-session narrative.
    for (const p of [doneFlagAbs, reportAbs]) {
      if (existsSync(p)) await rm(p);
    }

    // Best-effort: link .env and node_modules so `pnpm build` runs without a
    // fresh install (used by both the agent sessions and our build gate).
    await linkRepoArtifacts(this.logger, {
      sourceRepo: this.config.summario.repoPath,
      worktreePath,
    });

    await ensureMemoryFile(memoryAbs, shortId);

    const planAbs = join(issueDir, "plan.md");
    const planMarkdown =
      (await safeRead(planAbs)) ??
      (await safeRead(join(this.config.summario.repoPath, planRelPath))) ??
      (await safeRead(join(worktreePath, planRelPath))) ??
      "";
    const planPhases = parsePlanPhases(planMarkdown);

    if (planPhases.length === 0) {
      const reason = "plan.md has no recognisable \"## Phase N\" headings to build";
      this.store.markBuildFailed(issue.id, reason);
      this.store.recordEvent(issue.id, "building_failed", { reason });
      return { ok: false, attempts: 0, headSha: null, phases: [], tickResult: null, aborted: false };
    }

    const memoryRelPath = relative(worktreePath, memoryAbs);
    const reportRelPath = relative(worktreePath, reportAbs);
    const doneFlagRelPath = relative(worktreePath, doneFlagAbs);

    const outcomes: PhaseOutcome[] = [];
    let aborted = false;
    let buildFailed = false;

    for (const phase of planPhases) {
      await emitProgress({
        type: "phase_start",
        index: phase.index,
        total: planPhases.length,
        title: phase.title,
      });
      let attempt = 0;
      let phaseOk = false;
      let priorPhaseFailures = "";
      let reportNotes = "";
      let reportBrowser: PhaseOutcome["browserCheck"] = "skipped";

      while (attempt < this.config.builder.phaseMaxAttempts) {
        attempt++;
        for (const p of [doneFlagAbs, reportAbs]) {
          if (existsSync(p)) await rm(p);
        }

        const sessionStartedAt = new Date().toISOString();
        const prompt = buildPhasePrompt({
          workItemId: issue.id,
          shortId,
          sequenceId: issue.sequenceId,
          title: issue.name,
          descriptionText: issue.descriptionText,
          branch,
          planRelPath,
          memoryRelPath,
          phaseReportRelPath: reportRelPath,
          doneFlagRelPath,
          phaseIndex: phase.index,
          totalPhases: planPhases.length,
          phaseTitle: phase.title,
          phaseBody: phase.body,
          satisfiesAcRaw: phase.satisfiesAcRaw,
          attemptNumber: attempt,
          priorFailures: priorPhaseFailures,
        });

        this.store.recordEvent(issue.id, "build_phase_session_started", {
          phase: phase.index,
          totalPhases: planPhases.length,
          attempt,
          sessionStartedAt,
          promptLength: prompt.length,
        });

        const result = await this.claude.run({
          cwd: worktreePath,
          prompt,
          doneFlagPath: doneFlagAbs,
          timeoutMs: this.config.builder.phaseTimeoutMs,
          binary: this.config.claude.binary,
          extraArgs: this.config.claude.extraArgs,
          signal,
        });

        const verdictRaw = (await safeRead(doneFlagAbs)) ?? "";
        const verdict = verdictRaw.trim().split(/\s+/)[0] ?? "";

        this.store.recordEvent(issue.id, "build_phase_session_finished", {
          phase: phase.index,
          attempt,
          exitCode: result.exitCode,
          signal: result.signal,
          doneFlagSeen: result.doneFlagSeen,
          timedOut: result.timedOut,
          aborted: result.aborted,
          verdict,
        });

        // Reviewer interrupted us — stop everything so the orchestrator can
        // re-plan with the feedback included.
        if (result.aborted) {
          aborted = true;
          break;
        }

        const report = await safeRead(reportAbs);
        if (report) {
          reportNotes = matchField(report, "Notes") ?? reportNotes;
          const bc = matchField(report, "Browser check");
          if (bc) reportBrowser = parseBrowserCheck(bc);
        }

        if (result.doneFlagSeen && verdict === "phase-ok") {
          // The agent claims success — confirm with our own authoritative build.
          this.store.recordEvent(issue.id, "build_phase_build_started", {
            phase: phase.index,
            attempt,
          });
          const buildRes = await runPnpmBuild(worktreePath, this.config.builder.buildTimeoutMs);
          this.store.recordEvent(issue.id, "build_phase_build_finished", {
            phase: phase.index,
            attempt,
            ok: buildRes.ok,
            exitCode: buildRes.exitCode,
            timedOut: buildRes.timedOut,
          });
          if (buildRes.ok) {
            phaseOk = true;
          } else {
            const tail = buildRes.output.slice(-6_000);
            priorPhaseFailures += `\n\n### Attempt ${attempt}: agent reported phase-ok but the orchestrator's \`pnpm build\` FAILED\n\n\`\`\`\n${tail}\n\`\`\``;
            await appendMemorySection(
              memoryAbs,
              `### Phase ${phase.index} attempt ${attempt} — orchestrator build failed\n\n\`pnpm build\` did not pass after the agent reported phase-ok:\n\n\`\`\`\n${buildRes.output.slice(-4_000)}\n\`\`\``,
            );
          }
        } else {
          const reason = !result.doneFlagSeen
            ? result.timedOut
              ? "session timed out before writing done.flag"
              : "session exited before writing done.flag"
            : `agent verdict: ${verdict || "none"}`;
          priorPhaseFailures += `\n\n### Attempt ${attempt}: ${reason}\n\n${(reportNotes || "(no report)").slice(0, 2_000)}`;
          await appendMemorySection(
            memoryAbs,
            `### Phase ${phase.index} attempt ${attempt} — failed (${reason})\n\n${(reportNotes || "(no agent report)").slice(0, 2_000)}`,
          );
        }

        for (const p of [doneFlagAbs, reportAbs]) {
          if (existsSync(p)) await rm(p);
        }

        if (phaseOk) break;
        this.logger.warn(
          { workItemId: issue.id, phase: phase.index, attempt, verdict },
          "phase attempt failed",
        );
      }

      if (aborted) break;

      const outcome: PhaseOutcome = {
        index: phase.index,
        title: phase.title,
        status: phaseOk ? "complete" : "failed",
        attempts: attempt,
        satisfiesAc: phase.satisfiesAc,
        browserCheck: reportBrowser,
        notes: reportNotes.replace(/\s+/g, " ").trim().slice(0, 500),
      };
      outcomes.push(outcome);

      const sessionMarker = `phase-${phase.index} (${attempt} attempt${attempt === 1 ? "" : "s"}) @ ${new Date().toISOString()}`;
      await appendMemorySection(memoryAbs, formatPhaseSection(outcome, sessionMarker));

      this.store.recordEvent(
        issue.id,
        phaseOk ? "build_phase_complete" : "build_phase_failed",
        { phase: phase.index, attempts: attempt },
      );
      await emitProgress(
        phaseOk
          ? { type: "phase_complete", index: phase.index }
          : { type: "phase_failed", index: phase.index },
      );

      // Commit this phase from the orchestrator side (don't trust the agent to
      // commit). done.flag / phase-report.md are already removed so they don't
      // leak into history; this picks up code changes + the memory.md section.
      const commitMessage = phaseOk
        ? `feat(${shortId}): phase ${phase.index} — ${truncate(phase.title, 60)}`
        : `wip(${shortId}): phase ${phase.index} failed — ${truncate(phase.title, 60)}`;
      try {
        await this.git.commitAll(worktreePath, commitMessage);
      } catch (err) {
        this.logger.warn(
          { err, workItemId: issue.id, phase: phase.index },
          "phase commit failed; continuing",
        );
      }

      if (!phaseOk) {
        // Stop the loop — do not start later phases.
        buildFailed = true;
        break;
      }
    }

    // Reviewer abort: leave per-phase commits local, don't push or comment.
    // The orchestrator re-plans with the feedback folded in.
    if (aborted) {
      this.store.recordEvent(issue.id, "build_aborted_for_feedback", {
        phasesAttempted: outcomes.length,
      });
      for (const p of [doneFlagAbs, reportAbs]) {
        if (existsSync(p)) await rm(p);
      }
      return {
        ok: false,
        attempts: outcomes.reduce((n, o) => n + o.attempts, 0),
        headSha: null,
        phases: outcomes,
        tickResult: null,
        aborted: true,
      };
    }

    const ok =
      !buildFailed &&
      outcomes.length === planPhases.length &&
      outcomes.every((o) => o.status === "complete");

    // Orchestrator writes the human-facing summary (the agent no longer does).
    await writeFile(
      summaryAbs,
      buildSummaryMarkdown({ shortId, branch, ok, outcomes, totalPhases: planPhases.length }),
    );

    for (const p of [doneFlagAbs, reportAbs]) {
      if (existsSync(p)) await rm(p);
    }
    await this.git.commitAll(
      worktreePath,
      `chore(build): finalize memory + summary for ${shortId}`,
    );

    const headSha = await this.git.headSha(worktreePath);

    // Sync Plane description: inject plan inside fence and tick satisfied ACs.
    let tickResult: TickResult | null = null;
    try {
      tickResult = await this.syncPlaneDescription(issue.id, outcomes);
    } catch (err) {
      this.logger.warn(
        { err, workItemId: issue.id },
        "failed to sync plane description",
      );
      this.store.recordEvent(issue.id, "description_sync_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Push whatever we have. Even a partial build is worth pushing for review.
    let pushedSha: string | null = null;
    try {
      await this.git.push(worktreePath, this.config.summario.remoteName, branch);
      pushedSha = headSha;
      this.store.recordEvent(issue.id, "build_branch_pushed", {
        branch,
        headSha,
        phases: outcomes.length,
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
          phases: outcomes,
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
      const failedPhase = outcomes.find((o) => o.status === "failed");
      const reason = failedPhase
        ? `phase ${failedPhase.index} (${failedPhase.title}) failed after ${failedPhase.attempts} attempt(s)`
        : "build did not complete every phase";
      this.store.markBuildFailed(
        issue.id,
        `building agent did not complete cleanly: ${reason}`,
      );
      this.store.recordEvent(issue.id, "building_failed", {
        reason,
        phasesCompleted: outcomes.filter((o) => o.status === "complete").length,
        phasesTotal: planPhases.length,
      });
    }

    return {
      ok,
      attempts: outcomes.reduce((n, o) => n + o.attempts, 0),
      headSha: pushedSha,
      phases: outcomes,
      tickResult,
      aborted: false,
    };
  }

  /**
   * Phase 5 slice 5a-v2: spawn a fresh Claude session that reads a failed
   * Vercel build log and fixes the offending code, then commits. The
   * orchestrator pushes the resulting branch so Vercel re-deploys.
   *
   * Unlike `build()`, this doesn't retry within a single session (the
   * orchestrator-level loop with MAX_PREVIEW_FIXUP_ATTEMPTS does that).
   */
  async fixup(input: FixupInput): Promise<FixupResult> {
    const { issue, branch, worktreePath, planRelPath, previewUrl, buildLog, attemptNumber, priorFailures, signal } = input;
    const shortId = `PLANE-${issue.sequenceId}`;

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const memoryAbs = join(issueDir, "memory.md");
    const doneFlagAbs = join(issueDir, "done.flag");

    // Re-link node_modules / .env if the worktree lost them between runs.
    await linkRepoArtifacts(this.logger, {
      sourceRepo: this.config.summario.repoPath,
      worktreePath,
    });

    await ensureMemoryFile(memoryAbs, shortId);
    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

    const preSha = await this.git.headSha(worktreePath);

    const prompt = buildFixupPrompt({
      workItemId: issue.id,
      shortId,
      sequenceId: issue.sequenceId,
      title: issue.name,
      descriptionText: issue.descriptionText,
      branch,
      planRelPath,
      memoryRelPath: relative(worktreePath, memoryAbs),
      doneFlagRelPath: relative(worktreePath, doneFlagAbs),
      attemptNumber,
      previewUrl,
      buildLog,
      priorFailures,
    });

    this.store.recordEvent(issue.id, "fixup_session_started", {
      attempt: attemptNumber,
      promptLength: prompt.length,
      preSha,
      buildLogBytes: buildLog.length,
    });

    const result = await this.claude.run({
      cwd: worktreePath,
      prompt,
      doneFlagPath: doneFlagAbs,
      timeoutMs: this.config.claude.timeoutMs,
      binary: this.config.claude.binary,
      extraArgs: this.config.claude.extraArgs,
      signal,
    });

    this.store.recordEvent(issue.id, "fixup_session_finished", {
      attempt: attemptNumber,
      exitCode: result.exitCode,
      signal: result.signal,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
      aborted: result.aborted,
    });

    if (result.aborted) {
      if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);
      return {
        ok: false,
        doneFlagSeen: result.doneFlagSeen,
        aborted: true,
        verdict: "aborted",
        newHeadSha: preSha,
        advancedHead: false,
        pushedSha: null,
      };
    }

    const flagContent = await safeRead(doneFlagAbs);
    const verdict = (flagContent ?? "").trim().split(/\s+/)[0] ?? "";
    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

    // Commit any leftover agent files (the agent appended a fixup section to
    // memory.md; its code commit may or may not be in place).
    await this.git.commitAll(
      worktreePath,
      `chore(fixup): record fixup attempt ${attemptNumber} for ${shortId}`,
    );

    const newHeadSha = await this.git.headSha(worktreePath);
    const advancedHead = newHeadSha !== preSha;

    let pushedSha: string | null = null;
    if (advancedHead) {
      try {
        await this.git.push(
          worktreePath,
          this.config.summario.remoteName,
          branch,
        );
        pushedSha = newHeadSha;
        this.store.recordEvent(issue.id, "fixup_branch_pushed", {
          attempt: attemptNumber,
          branch,
          headSha: newHeadSha,
        });
      } catch (err) {
        this.logger.error({ err, branch }, "git push (after fixup) failed");
        this.store.recordEvent(issue.id, "fixup_push_failed", {
          attempt: attemptNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const ok = verdict === "fixup-ok" && advancedHead;
    return {
      ok,
      doneFlagSeen: result.doneFlagSeen,
      aborted: false,
      verdict,
      newHeadSha,
      advancedHead,
      pushedSha,
    };
  }

  private async syncPlaneDescription(
    workItemId: string,
    phases: PhaseOutcome[],
  ): Promise<TickResult> {
    const detail = await this.plane.retrieveIssue(workItemId);
    const currentHtml = detail.descriptionHtml ?? "";

    // Phase 6.5: the dashboard fence is owned by the orchestrator now, so the
    // builder no longer dumps the plan into the description — it only ticks the
    // human-facing AC checkboxes (which live ABOVE the fence).
    const satisfied = new Set<number>();
    for (const phase of phases) {
      if (phase.status !== "complete") continue;
      for (const ac of phase.satisfiesAc) satisfied.add(ac);
    }
    const indices = [...satisfied].sort((a, b) => a - b);

    const tickResult = tickAcceptanceCriteria(currentHtml, indices);
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

export async function linkRepoArtifacts(
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
 * Parse the uniform `## Phase N` sections the orchestrator writes to memory.md
 * back into structured outcomes. Tolerant: unknown lines skipped, missing
 * fields default to safe values, malformed blocks don't break the rest. (h3
 * `### Phase N attempt M` failure sub-notes and `## E2E` / `## Fixup` sections
 * are ignored by the heading match.)
 */
export function parsePhaseOutcomes(memoryMd: string): PhaseOutcome[] {
  const headings: Array<{ index: number; title: string; start: number; end: number }> = [];
  const matches = [...memoryMd.matchAll(PHASE_HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const next = matches[i + 1];
    headings.push({
      index: Number(m[1]!),
      title: m[2]!.trim(),
      start: (m.index ?? 0) + m[0].length,
      end: next?.index ?? memoryMd.length,
    });
  }

  const outcomes: PhaseOutcome[] = [];
  for (const h of headings) {
    const body = memoryMd.slice(h.start, h.end);
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

function parseBrowserCheck(raw: string | null): PhaseOutcome["browserCheck"] {
  if (!raw) return "unknown";
  const t = raw.trim().toLowerCase();
  if (t.startsWith("pass")) return "passed";
  if (t.startsWith("fail")) return "failed";
  if (t.startsWith("skip")) return "skipped";
  return "unknown";
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

function buildSummaryMarkdown(input: {
  shortId: string;
  branch: string;
  ok: boolean;
  outcomes: PhaseOutcome[];
  totalPhases: number;
}): string {
  const lines: string[] = [];
  lines.push(`# ${input.shortId} — build summary`);
  lines.push("");
  lines.push(
    input.ok
      ? `All ${input.totalPhases} phase(s) built successfully on \`${input.branch}\`.`
      : `Build stopped early: ${input.outcomes.filter((o) => o.status === "complete").length}/${input.totalPhases} phase(s) completed on \`${input.branch}\`.`,
  );
  lines.push("");
  lines.push("## Phases");
  lines.push("");
  for (const o of input.outcomes) {
    const ac = o.satisfiesAc.length > 0 ? ` (AC ${o.satisfiesAc.join(", ")})` : "";
    lines.push(`- Phase ${o.index} — ${o.title}: **${o.status}**${ac}`);
    if (o.notes.trim().length > 0) lines.push(`  - ${o.notes.trim()}`);
  }
  if (input.outcomes.length < input.totalPhases) {
    lines.push(
      `- Phases ${input.outcomes.length + 1}–${input.totalPhases}: **not started** (earlier phase failed).`,
    );
  }
  lines.push("");
  lines.push("Each phase was implemented by its own Claude session; see memory.md for the full per-session log.");
  lines.push("");
  return lines.join("\n");
}

function buildResultCommentHtml(input: {
  ok: boolean;
  phases: PhaseOutcome[];
  branch: string;
  headSha: string | null;
  tickResult: TickResult | null;
}): string {
  const verdict = input.ok
    ? "<strong>Build succeeded.</strong>"
    : "<strong>Build did not complete.</strong>";

  const phaseList = input.phases.length === 0
    ? "<p><em>No phases were built.</em></p>"
    : `<ol>${input.phases
        .map((p) =>
          `<li>Phase ${p.index} — ${escapeHtml(p.title)} — <code>${p.status}</code> (${p.attempts} session${p.attempts === 1 ? "" : "s"})${
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

  return `<p>${verdict} One Claude session per phase.</p>
<p>Branch: <code>${escapeHtml(input.branch)}</code>${sha}</p>
${phaseList}
${tickLine}`;
}
