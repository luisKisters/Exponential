import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Builder, BuildingError, type BuildResult } from "./builder.js";
import type { Config } from "./config.js";
import { E2eRunner, type E2eResult } from "./e2e.js";
import { Git } from "./git.js";
import type { Logger } from "./logger.js";
import { PRIORITY_RANK, type PlaneApi, type PlaneComment, type PlaneIssue } from "./plane.js";
import {
  Planner,
  PlanningAbortedError,
  PlanningError,
  type PlanResult,
} from "./planner.js";
import type { IssueRow, Store } from "./store.js";
import {
  deriveGhRepo,
  fetchBuildLogs,
  waitForPreview,
  type PreviewResult,
} from "./vercel.js";

type StageOutcome<T> =
  | { ok: true; aborted: false; result: T }
  | { ok: false; aborted: true }
  | { ok: false; aborted: false; reason: string };

export class Orchestrator {
  private timer?: NodeJS.Timeout;
  private feedbackTimer?: NodeJS.Timeout;
  private inFlightCycle = false;
  private inFlightFeedbackTick = false;
  private inFlightPipeline?: Promise<void>;
  private inFlightIssueId: string | null = null;
  private stopped = false;
  private inProgressStateId: string | undefined;
  private humanReviewStateId: string | undefined;
  private failedStateId: string | undefined;
  private ghRepo: string | undefined;
  private resolveStop?: () => void;
  /** Active per-stage abort controllers keyed by work-item-id. Multiple per issue is allowed during transitions. */
  private readonly stageAborters = new Map<string, Set<AbortController>>();
  private readonly planner: Planner;
  private readonly builder: Builder;
  private readonly e2e: E2eRunner;
  private readonly git: Git;

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly plane: PlaneApi,
    private readonly store: Store,
  ) {
    this.planner = new Planner(logger, config, plane, store);
    this.builder = new Builder(logger, config, plane, store);
    this.e2e = new E2eRunner(logger, config, store);
    this.git = new Git(logger, config.summario.repoPath);
  }

  async start(): Promise<void> {
    await this.planner.ensureReady();
    this.inProgressStateId = await this.plane.findStateIdByName(
      this.config.plane.inProgressStatus,
    );
    this.humanReviewStateId = await this.plane.findStateIdByName(
      this.config.plane.humanReviewStatus,
    );
    this.failedStateId = await this.plane.findStateIdByName(
      this.config.plane.failedStatus,
    );
    this.ghRepo = await this.resolveGithubRepo();

    this.logger.info(
      {
        stateName: this.config.plane.inProgressStatus,
        stateId: this.inProgressStateId,
        humanReviewStateId: this.humanReviewStateId,
        failedStateId: this.failedStateId,
        ghRepo: this.ghRepo,
        pollIntervalMs: this.config.pollIntervalMs,
        summarioRepo: this.config.summario.repoPath,
      },
      "orchestrator started",
    );

    await this.resumeOrphans();

    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.config.pollIntervalMs);

    // Comment polling is a separate, faster cadence so reviewer interrupts
    // don't have to wait a full poll interval.
    void this.runFeedbackTick();
    this.feedbackTimer = setInterval(() => {
      void this.runFeedbackTick();
    }, this.config.commentPollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      delete this.timer;
    }
    if (this.feedbackTimer) {
      clearInterval(this.feedbackTimer);
      delete this.feedbackTimer;
    }
    if (this.inFlightCycle) {
      this.logger.info("waiting for in-flight poll cycle to finish");
      await new Promise<void>((resolve) => {
        this.resolveStop = resolve;
      });
    }
    if (this.inFlightPipeline) {
      this.logger.info("waiting for in-flight pipeline run to finish");
      try {
        await this.inFlightPipeline;
      } catch (err) {
        this.logger.error({ err }, "in-flight pipeline errored during shutdown");
      }
    }
    this.logger.info("orchestrator stopped");
  }

  private async runCycle(): Promise<void> {
    if (this.inFlightCycle || this.stopped) return;
    this.inFlightCycle = true;
    try {
      await this.pollOnce();
    } catch (err) {
      this.logger.error({ err }, "poll cycle failed");
    } finally {
      this.inFlightCycle = false;
      if (this.stopped && this.resolveStop) {
        this.resolveStop();
        delete this.resolveStop;
      }
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.inProgressStateId) return;

    const active = this.store.hasActiveIssue();
    if (active) {
      this.logger.debug(
        {
          workItemId: active.plane_work_item_id,
          sequenceId: active.sequence_id,
          status: active.status,
        },
        "active issue in flight, skipping pickup",
      );
      return;
    }

    const candidates = await this.plane.listIssuesByState(this.inProgressStateId);

    const fresh = candidates.filter((issue) => {
      // Plane's API has historically ignored the `state` query param and
      // returned all issues. Re-check the state id client-side so a Backlog /
      // Todo issue doesn't slip through.
      if (issue.stateId !== this.inProgressStateId) return false;
      const row = this.store.getIssue(issue.id);
      // Only pick truly new issues. Anything we've ever seen — including
      // terminal states — stays alone until the user explicitly clears the
      // SQLite row. Without this guard a failed pipeline would re-trigger
      // forever, since Plane still has the issue in "In Progress".
      return !row;
    });

    if (fresh.length === 0) {
      this.logger.debug("no fresh in-progress issues to pick up");
      return;
    }

    const sorted = fresh.slice().sort(compareIssues);
    const next = sorted[0]!;

    this.logger.info(
      {
        workItemId: next.id,
        sequenceId: next.sequenceId,
        priority: next.priority,
        name: next.name,
        candidates: fresh.length,
      },
      "picking up issue",
    );

    const inserted = this.store.recordPickup({
      workItemId: next.id,
      workspaceSlug: this.config.plane.workspaceSlug,
      projectId: next.projectId,
      sequenceId: next.sequenceId,
      name: next.name,
      priority: next.priority,
    });

    if (!inserted) {
      this.logger.warn(
        { workItemId: next.id },
        "pickup race detected, issue already active",
      );
      return;
    }

    try {
      const pickupComment = await this.plane.postComment(
        next.id,
        "<p>Picked up by Exponential.</p>",
      );
      this.store.advanceCommentWatermark(next.id, pickupComment.createdAt);
    } catch (err) {
      this.logger.error(
        { err, workItemId: next.id },
        "failed to post pickup comment",
      );
      this.store.recordEvent(next.id, "pickup_comment_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.startPipeline(next);
  }

  /**
   * Single entry point that wraps `runPipeline` in the in-flight bookkeeping
   * the orchestrator relies on (`inFlightPipeline` promise + `inFlightIssueId`
   * marker). Reused by `pollOnce`, `resumeOrphans`, and the feedback watcher's
   * "reopen from human review" path.
   */
  private startPipeline(issue: PlaneIssue): void {
    if (this.inFlightPipeline) {
      this.logger.warn(
        { workItemId: issue.id },
        "refusing to start a pipeline while another is in flight",
      );
      return;
    }
    this.inFlightIssueId = issue.id;
    this.inFlightPipeline = this.runPipeline(issue).finally(() => {
      delete this.inFlightPipeline;
      this.inFlightIssueId = null;
    });
  }

  /**
   * Restart recovery: if an issue was left in a resumable state (`planned`
   * after planning, `built` after building), resume from the appropriate
   * stage. Pre-checks Plane to skip safely if the issue was deleted.
   */
  private async resumeOrphans(): Promise<void> {
    const resumable = this.store.findResumableIssue();
    if (!resumable) return;
    const { row, resumeFrom } = resumable;
    if (!row.branch_name || !row.worktree_path || !row.plan_path) {
      this.logger.warn(
        { workItemId: row.plane_work_item_id, status: row.status },
        "resumable row is missing branch/worktree/plan path; skipping recovery",
      );
      return;
    }
    if (!this.inProgressStateId) return;

    try {
      await this.plane.retrieveIssue(row.plane_work_item_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { workItemId: row.plane_work_item_id, err },
        "orphan issue is no longer retrievable from Plane; marking failed and skipping recovery",
      );
      this.store.markFailed(row.plane_work_item_id, `recovery aborted: ${message}`);
      this.store.recordEvent(row.plane_work_item_id, "recovery_aborted", {
        error: message,
      });
      return;
    }

    this.logger.info(
      {
        workItemId: row.plane_work_item_id,
        sequenceId: row.sequence_id,
        branch: row.branch_name,
        resumeFrom,
      },
      "resuming orphaned issue",
    );
    const issue = issueFromRow(row, this.inProgressStateId);
    const planResult: PlanResult = {
      branch: row.branch_name,
      worktreePath: row.worktree_path,
      planPath: row.plan_path,
      headSha: row.head_sha ?? "",
      phaseTitles: [],
    };
    this.inFlightIssueId = issue.id;
    this.inFlightPipeline = this.continuePipeline(issue, planResult, resumeFrom)
      .finally(() => {
        delete this.inFlightPipeline;
        this.inFlightIssueId = null;
      });
  }

  // ---------- comment / feedback watcher ----------

  private async runFeedbackTick(): Promise<void> {
    if (this.inFlightFeedbackTick || this.stopped) return;
    this.inFlightFeedbackTick = true;
    try {
      await this.tickFeedback();
    } catch (err) {
      this.logger.error({ err }, "feedback tick failed");
    } finally {
      this.inFlightFeedbackTick = false;
    }
  }

  private async tickFeedback(): Promise<void> {
    const targets = this.store.listFeedbackTargets();
    for (const row of targets) {
      try {
        await this.pollIssueForFeedback(row);
      } catch (err) {
        this.logger.warn(
          { err, workItemId: row.plane_work_item_id },
          "feedback poll failed for issue",
        );
      }
    }
  }

  private async pollIssueForFeedback(row: IssueRow): Promise<void> {
    const since = row.last_seen_comment_at;
    const sinceMs = since ? Date.parse(since) : 0;

    let comments: PlaneComment[];
    try {
      comments = await this.plane.listComments(row.plane_work_item_id);
    } catch (err) {
      this.logger.warn(
        { err, workItemId: row.plane_work_item_id },
        "could not list comments for feedback poll",
      );
      return;
    }

    const fresh = comments
      .filter((c) => c.createdAt.getTime() > sinceMs)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (fresh.length === 0) return;

    // Advance the watermark past these comments — whether or not we end up
    // treating them as feedback, we never want to re-process the same comment
    // twice.
    const newest = fresh[fresh.length - 1]!;
    this.store.advanceCommentWatermark(row.plane_work_item_id, newest.createdAt);

    const meaningful = fresh
      .map((c) => c.text.trim())
      .filter((t) => t.length > 0)
      .join("\n\n");
    if (meaningful.length === 0) return;

    this.logger.info(
      {
        workItemId: row.plane_work_item_id,
        sequenceId: row.sequence_id,
        commentCount: fresh.length,
        status: row.status,
      },
      "reviewer feedback detected",
    );
    this.store.appendPendingFeedback(row.plane_work_item_id, meaningful);
    this.store.recordEvent(row.plane_work_item_id, "feedback_detected", {
      commentIds: fresh.map((c) => c.id),
      preview: meaningful.slice(0, 200),
    });

    // If the issue is mid-pipeline, abort the active stage so the loop catches
    // up and re-plans with the feedback included.
    const aborters = this.stageAborters.get(row.plane_work_item_id);
    if (aborters && aborters.size > 0) {
      this.logger.info(
        { workItemId: row.plane_work_item_id, count: aborters.size },
        "interrupting active claude session for reviewer feedback",
      );
      for (const ctrl of aborters) ctrl.abort();
      this.store.recordEvent(
        row.plane_work_item_id,
        "session_aborted_for_feedback",
        {},
      );
      return;
    }

    // Otherwise the issue is in `human_review` / `failed` (or a status with
    // no active session — the pipeline crashed). Reopen it and kick off a
    // fresh pipeline if nothing else is running.
    if (this.inFlightPipeline) {
      this.logger.info(
        { workItemId: row.plane_work_item_id, activeIssueId: this.inFlightIssueId },
        "another pipeline is in flight; feedback queued until it finishes",
      );
      return;
    }
    if (!row.branch_name || !row.worktree_path || !row.plan_path) {
      this.logger.warn(
        { workItemId: row.plane_work_item_id },
        "feedback received but issue has no branch/worktree to reopen against; ignoring",
      );
      return;
    }
    if (!this.inProgressStateId) return;
    this.store.reopenForFeedback(row.plane_work_item_id);
    this.store.recordEvent(row.plane_work_item_id, "feedback_reopened", {
      fromStatus: row.status,
    });
    const issue = issueFromRow(row, this.inProgressStateId);
    this.startPipeline(issue);
  }

  // ---------- stage-abort registry ----------

  /**
   * Register an AbortController for the currently-executing Claude session
   * stage. Returns the signal to pass into the stage runner and a release
   * function that the caller MUST invoke (via try/finally) once the stage is
   * done — otherwise the watcher will try to abort an already-finished pty.
   */
  private registerStageAbort(workItemId: string): {
    signal: AbortSignal;
    release: () => void;
  } {
    const ctrl = new AbortController();
    let set = this.stageAborters.get(workItemId);
    if (!set) {
      set = new Set();
      this.stageAborters.set(workItemId, set);
    }
    set.add(ctrl);
    return {
      signal: ctrl.signal,
      release: () => {
        const s = this.stageAborters.get(workItemId);
        if (!s) return;
        s.delete(ctrl);
        if (s.size === 0) this.stageAborters.delete(workItemId);
      },
    };
  }

  /**
   * Full pipeline: plan → build → wait-preview → e2e, with up to `maxLoops`
   * iterations on E2E failure. Each loop re-runs planning with the prior
   * failure notes folded in.
   */
  private async runPipeline(issue: PlaneIssue): Promise<void> {
    await this.pipelineLoop(issue, /* planResult */ null, "plan");
  }

  /** Used by restart recovery to skip already-completed stages. */
  private async continuePipeline(
    issue: PlaneIssue,
    planResult: PlanResult,
    resumeFrom: "build" | "e2e",
  ): Promise<void> {
    await this.pipelineLoop(issue, planResult, resumeFrom);
  }

  private async pipelineLoop(
    issue: PlaneIssue,
    seedPlan: PlanResult | null,
    startStage: "plan" | "build" | "e2e",
  ): Promise<void> {
    let loop = 1;
    let planResult: PlanResult | null = seedPlan;
    let buildResult: BuildResult | null = null;
    let priorFailures = "";
    let stage = startStage;

    while (loop <= this.config.pipeline.maxLoops) {
      this.logger.info(
        { workItemId: issue.id, loop, stage },
        "pipeline loop iteration",
      );

      if (stage === "plan") {
        if (loop > 1) this.store.resetForLoop(issue.id, loop);
        priorFailures = this.foldInPendingFeedback(issue.id, priorFailures, loop);
        const out = await this.runPlanning(issue, {
          loopNumber: loop,
          priorFailures,
        });
        if (out.aborted) {
          // Reviewer interrupted mid-plan. The watcher already wrote feedback
          // to pending_feedback; the next iteration drains it via
          // foldInPendingFeedback above. Do NOT advance the loop counter —
          // it isn't an E2E failure, it's a steering correction.
          stage = "plan";
          continue;
        }
        if (!out.ok) return;
        planResult = out.result;
        stage = "build";
      }

      if (stage === "build") {
        if (!planResult) return;
        const out = await this.runBuilding(issue, planResult);
        if (out.aborted) {
          stage = "plan";
          continue;
        }
        if (!out.ok) {
          await this.finishPipeline(issue, "failed", {
            reason: out.reason ?? "build did not complete",
            previewUrl: null,
            planResult,
            loop,
          });
          return;
        }
        buildResult = out.result;
        stage = "e2e";
      }

      if (stage === "e2e") {
        if (!planResult) return;
        const sha = buildResult?.headSha ?? planResult.headSha;
        if (!sha) {
          await this.finishPipeline(issue, "failed", {
            reason: "no sha to look up vercel preview",
            previewUrl: null,
            planResult,
            loop,
          });
          return;
        }

        const previewOutcome = await this.waitForOrFixupPreview(
          issue,
          planResult,
          sha,
          loop,
        );
        if (previewOutcome.aborted) {
          stage = "plan";
          continue;
        }
        if (!previewOutcome.ok) {
          await this.finishPipeline(issue, "failed", {
            reason: previewOutcome.reason ?? "vercel preview never became available",
            previewUrl: previewOutcome.previewUrl,
            planResult,
            loop,
          });
          return;
        }
        const previewUrl = previewOutcome.previewUrl;

        // Got a working preview — reset the fixup counter for next time.
        this.store.resetPreviewFixupAttempts(issue.id);

        const out = await this.runE2e(issue, planResult, previewUrl, loop, priorFailures);
        if (out.aborted) {
          stage = "plan";
          continue;
        }
        if (!out.ok) {
          await this.finishPipeline(issue, "failed", {
            reason: out.reason ?? "e2e stage failed",
            previewUrl,
            planResult,
            loop,
          });
          return;
        }
        const e2eResult = out.result;

        if (e2eResult.verdict === "e2e-passed") {
          await this.finishPipeline(issue, "human_review", {
            reason: "e2e passed",
            previewUrl,
            planResult,
            loop,
          });
          return;
        }

        if (e2eResult.verdict === "e2e-blocked") {
          await this.finishPipeline(issue, "failed", {
            reason: "e2e blocked (couldn't verify — see failures.md)",
            previewUrl,
            planResult,
            loop,
          });
          return;
        }

        // e2e-failed or no-verdict: accumulate context and loop back to plan.
        const failuresContent = await readFailuresFile(planResult.worktreePath, issue.id);
        priorFailures = `## Loop ${loop} E2E failure\n\nfailures.md after loop ${loop}:\n\n${(failuresContent ?? "(empty)").slice(0, 16_000)}`;

        loop++;
        if (loop > this.config.pipeline.maxLoops) {
          await this.finishPipeline(issue, "failed", {
            reason: `e2e failed after ${this.config.pipeline.maxLoops} pipeline loop(s)`,
            previewUrl,
            planResult,
            loop: loop - 1,
          });
          return;
        }
        stage = "plan";
      }
    }
  }

  /**
   * Drain any reviewer feedback that arrived since the last loop iteration and
   * prepend it to `priorFailures`. The planning prompt already routes
   * priorFailures into a visible "this is a revision" block, so feedback
   * piggybacks on that channel without a prompt-shape change.
   */
  private foldInPendingFeedback(
    workItemId: string,
    priorFailures: string,
    loop: number,
  ): string {
    const feedback = this.store.takePendingFeedback(workItemId);
    if (!feedback) return priorFailures;
    this.store.recordEvent(workItemId, "feedback_consumed", {
      loop,
      preview: feedback.slice(0, 200),
    });
    const header = `## Reviewer feedback (Plane comments)\n\nA human reviewer left the following note(s) and wants the plan revised to address them. Do not ignore.\n\n${feedback.trim()}`;
    return priorFailures.trim().length > 0
      ? `${header}\n\n${priorFailures}`
      : header;
  }

  private async runPlanning(
    issue: PlaneIssue,
    opts: { loopNumber: number; priorFailures: string },
  ): Promise<StageOutcome<PlanResult>> {
    const stageAbort = this.registerStageAbort(issue.id);
    try {
      const result = await this.planner.plan(issue, {
        loopNumber: opts.loopNumber,
        priorFailures: opts.priorFailures,
        signal: stageAbort.signal,
      });
      this.logger.info(
        {
          workItemId: issue.id,
          sequenceId: issue.sequenceId,
          branch: result.branch,
          phases: result.phaseTitles.length,
          headSha: result.headSha.slice(0, 12),
          loop: opts.loopNumber,
        },
        "planning complete",
      );
      return { ok: true, aborted: false, result };
    } catch (err) {
      if (err instanceof PlanningAbortedError) {
        this.logger.info(
          { workItemId: issue.id, loop: opts.loopNumber },
          "planning aborted for reviewer feedback",
        );
        return { ok: false, aborted: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err, workItemId: issue.id, sequenceId: issue.sequenceId },
        "planning failed",
      );
      this.store.markPlanningFailed(issue.id, message);
      this.store.recordEvent(issue.id, "planning_failed", {
        error: message,
        loop: opts.loopNumber,
        details: err instanceof PlanningError ? {
          worktreePath: err.details.worktreePath,
          branch: err.details.branch,
        } : undefined,
      });
      try {
        const c = await this.plane.postComment(
          issue.id,
          `<p><strong>Planning failed (loop ${opts.loopNumber}).</strong></p><pre>${escapeHtml(message)}</pre>`,
        );
        this.store.advanceCommentWatermark(issue.id, c.createdAt);
      } catch {
        // best-effort
      }
      return { ok: false, aborted: false, reason: message };
    } finally {
      stageAbort.release();
    }
  }

  private async runBuilding(
    issue: PlaneIssue,
    planResult: PlanResult,
  ): Promise<StageOutcome<BuildResult>> {
    const stageAbort = this.registerStageAbort(issue.id);
    try {
      const detail = await this.plane.retrieveIssue(issue.id);
      const result = await this.builder.build({
        issue: detail,
        branch: planResult.branch,
        worktreePath: planResult.worktreePath,
        planRelPath: planResult.planPath,
        signal: stageAbort.signal,
      });
      this.logger.info(
        {
          workItemId: issue.id,
          sequenceId: issue.sequenceId,
          branch: planResult.branch,
          ok: result.ok,
          aborted: result.aborted,
          attempts: result.attempts,
          headSha: result.headSha?.slice(0, 12) ?? null,
          phases: result.phases.length,
          ticked: result.tickResult?.matched ?? [],
        },
        "build stage finished",
      );
      if (result.aborted) {
        return { ok: false, aborted: true };
      }
      if (!result.ok) {
        return {
          ok: false,
          aborted: false,
          reason: `build did not complete cleanly after ${result.attempts} attempt(s)`,
        };
      }
      return { ok: true, aborted: false, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err, workItemId: issue.id, sequenceId: issue.sequenceId },
        "building threw",
      );
      this.store.markBuildFailed(issue.id, message);
      this.store.recordEvent(issue.id, "building_threw", {
        error: message,
        details: err instanceof BuildingError ? {
          worktreePath: err.details.worktreePath,
          branch: err.details.branch,
        } : undefined,
      });
      return { ok: false, aborted: false, reason: message };
    } finally {
      stageAbort.release();
    }
  }

  private async waitForPreviewSafely(
    issue: PlaneIssue,
    sha: string,
  ): Promise<PreviewResult | null> {
    if (!this.ghRepo) {
      this.logger.error(
        { workItemId: issue.id },
        "SUMMARIO_GITHUB_REPO unresolved; cannot poll for vercel preview",
      );
      return null;
    }
    this.store.recordEvent(issue.id, "preview_wait_started", { sha });
    try {
      const result = await waitForPreview(this.logger, {
        ghRepo: this.ghRepo,
        sha,
        timeoutMs: this.config.vercel.readyTimeoutMs,
      });
      this.store.recordEvent(issue.id, "preview_wait_finished", {
        sha,
        state: result.state,
        url: result.url,
        deploymentId: result.deploymentId,
        timedOut: result.timedOut,
      });
      return result;
    } catch (err) {
      this.logger.error({ err, sha }, "preview wait threw");
      this.store.recordEvent(issue.id, "preview_wait_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Phase 5 slice 5a-v2: wait for a Vercel preview to succeed, OR spawn a
   * sequence of Claude fixup sessions that diagnose the build failure from
   * the captured log and try to fix the code. Each fixup ends with a new
   * commit + push, which triggers a fresh Vercel deploy on a new SHA. Caps
   * at `MAX_PREVIEW_FIXUP_ATTEMPTS`.
   */
  private async waitForOrFixupPreview(
    issue: PlaneIssue,
    planResult: PlanResult,
    initialSha: string,
    loop: number,
  ): Promise<
    | { ok: true; aborted: false; previewUrl: string }
    | { ok: false; aborted: true; previewUrl: null }
    | { ok: false; aborted: false; previewUrl: string | null; reason: string }
  > {
    let sha = initialSha;
    let priorFailures = "";

    while (true) {
      const result = await this.waitForPreviewSafely(issue, sha);
      if (result && result.state === "success" && result.url) {
        return { ok: true, aborted: false, previewUrl: result.url };
      }

      const previewUrl = result?.url ?? null;
      const failureState = result?.state ?? "unreachable";
      const attempt = this.store.incrementPreviewFixupAttempt(issue.id);
      const cap = this.config.vercel.maxPreviewFixupAttempts;

      this.store.recordEvent(issue.id, "preview_fixup_planned", {
        attempt,
        cap,
        sha,
        state: failureState,
        previewUrl,
      });

      if (attempt > cap) {
        return {
          ok: false,
          aborted: false,
          previewUrl,
          reason: `vercel preview failed after ${cap} fixup attempt(s)`,
        };
      }

      if (!previewUrl) {
        // Without a deployment URL we can't fetch logs, so we can't ask an
        // agent to fix anything productive. Surface as terminal.
        return {
          ok: false,
          aborted: false,
          previewUrl: null,
          reason: `no vercel preview URL available (state=${failureState}); cannot run fixup agent`,
        };
      }

      let buildLog = "";
      try {
        buildLog = await fetchBuildLogs(previewUrl);
        this.store.recordEvent(issue.id, "preview_build_log_captured", {
          attempt,
          previewUrl,
          bytes: buildLog.length,
        });
      } catch (err) {
        this.logger.warn(
          { err, previewUrl },
          "failed to fetch vercel build logs; spawning fixup with empty log",
        );
        this.store.recordEvent(issue.id, "preview_build_log_failed", {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const c = await this.plane.postComment(
          issue.id,
          `<p><strong>Vercel preview build failed</strong> on <code>${escapeHtml(sha.slice(0, 12))}</code> (state: <code>${escapeHtml(failureState)}</code>). Spawning fixup agent — attempt ${attempt}/${cap}. <a href="${escapeHtml(previewUrl)}">Vercel logs</a>.</p>`,
        );
        this.store.advanceCommentWatermark(issue.id, c.createdAt);
      } catch {
        // best-effort
      }

      const detail = await this.plane.retrieveIssue(issue.id);
      const aborter = this.registerStageAbort(issue.id);
      let fixupResult;
      try {
        fixupResult = await this.builder.fixup({
          issue: detail,
          branch: planResult.branch,
          worktreePath: planResult.worktreePath,
          planRelPath: planResult.planPath,
          previewUrl,
          buildLog,
          attemptNumber: attempt,
          priorFailures,
          signal: aborter.signal,
        });
      } finally {
        aborter.release();
      }

      if (fixupResult.aborted) {
        return { ok: false, aborted: true, previewUrl: null };
      }

      if (!fixupResult.advancedHead) {
        // Agent gave up without producing a commit. No new SHA means a re-poll
        // would just see the same failure — terminate this loop.
        return {
          ok: false,
          aborted: false,
          previewUrl,
          reason: `fixup attempt ${attempt} produced no commit (verdict: ${fixupResult.verdict || "n/a"})`,
        };
      }

      // Carry context forward for the next attempt's prompt.
      priorFailures = `## Fixup attempt ${attempt} (verdict: ${fixupResult.verdict || "n/a"})\n\nThe build log above produced commit ${fixupResult.newHeadSha.slice(0, 12)}, but the new build will be checked on the next loop. If you see the same root cause repeat, the previous fix did not address it.`;
      sha = fixupResult.pushedSha ?? fixupResult.newHeadSha;
    }
  }

  private async runE2e(
    issue: PlaneIssue,
    planResult: PlanResult,
    previewUrl: string,
    loop: number,
    priorFailures: string,
  ): Promise<StageOutcome<E2eResult>> {
    const stageAbort = this.registerStageAbort(issue.id);
    try {
      const detail = await this.plane.retrieveIssue(issue.id);
      const result = await this.e2e.verify({
        issue: detail,
        branch: planResult.branch,
        worktreePath: planResult.worktreePath,
        previewUrl,
        loopNumber: loop,
        priorFailures,
        signal: stageAbort.signal,
      });
      this.logger.info(
        {
          workItemId: issue.id,
          loop,
          verdict: result.verdict,
          doneFlagSeen: result.doneFlagSeen,
          timedOut: result.timedOut,
          aborted: result.aborted,
        },
        "e2e stage finished",
      );
      if (result.aborted) {
        return { ok: false, aborted: true };
      }
      return { ok: true, aborted: false, result };
    } catch (err) {
      this.logger.error({ err, workItemId: issue.id }, "e2e threw");
      this.store.recordEvent(issue.id, "e2e_threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        aborted: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      stageAbort.release();
    }
  }

  /**
   * Single exit point for the pipeline. Handles Plane state transition, the
   * final comment, sqlite status, and optional worktree cleanup.
   */
  private async finishPipeline(
    issue: PlaneIssue,
    outcome: "human_review" | "failed",
    input: {
      reason: string;
      previewUrl: string | null;
      planResult: PlanResult | null;
      loop: number;
    },
  ): Promise<void> {
    const targetStateId =
      outcome === "human_review" ? this.humanReviewStateId : this.failedStateId;
    const targetStateName =
      outcome === "human_review"
        ? this.config.plane.humanReviewStatus
        : this.config.plane.failedStatus;

    if (outcome === "human_review") {
      this.store.markHumanReview(issue.id, { previewUrl: input.previewUrl });
    } else {
      this.store.markFailed(issue.id, input.reason);
    }
    this.store.recordEvent(issue.id, `pipeline_${outcome}`, {
      reason: input.reason,
      previewUrl: input.previewUrl,
      loop: input.loop,
    });

    if (targetStateId) {
      try {
        await this.plane.updateState(issue.id, targetStateId);
      } catch (err) {
        this.logger.error(
          { err, workItemId: issue.id, targetStateName },
          "failed to transition plane state",
        );
        this.store.recordEvent(issue.id, "plane_state_update_failed", {
          error: err instanceof Error ? err.message : String(err),
          targetStateName,
        });
      }
    } else {
      this.logger.warn(
        { targetStateName },
        "plane state id unresolved; leaving plane state untouched",
      );
    }

    try {
      const c = await this.plane.postComment(
        issue.id,
        buildFinalCommentHtml({ outcome, ...input }),
      );
      this.store.advanceCommentWatermark(issue.id, c.createdAt);
    } catch (err) {
      this.logger.error(
        { err, workItemId: issue.id },
        "failed to post final pipeline comment",
      );
    }

    if (this.config.pipeline.cleanWorktreeOnFinish && input.planResult) {
      try {
        await this.git.removeWorktree(input.planResult.worktreePath);
        this.store.recordEvent(issue.id, "worktree_cleaned", {
          worktreePath: input.planResult.worktreePath,
        });
      } catch (err) {
        this.logger.warn({ err }, "worktree cleanup failed");
      }
    }
  }

  private async resolveGithubRepo(): Promise<string | undefined> {
    if (this.config.summario.githubRepo) return this.config.summario.githubRepo;
    try {
      const remoteUrl = await this.git.getRemoteUrl(this.config.summario.remoteName);
      return deriveGhRepo(remoteUrl) ?? undefined;
    } catch (err) {
      this.logger.warn(
        { err },
        "could not derive github repo from origin; set SUMMARIO_GITHUB_REPO",
      );
      return undefined;
    }
  }
}

function issueFromRow(row: IssueRow, stateId: string): PlaneIssue {
  return {
    id: row.plane_work_item_id,
    sequenceId: row.sequence_id,
    name: row.name,
    priority: row.priority,
    stateId,
    updatedAt: new Date(row.updated_at),
    createdAt: new Date(row.picked_up_at),
    projectId: row.project_id,
  };
}

async function readFailuresFile(
  worktreePath: string,
  workItemId: string,
): Promise<string | null> {
  const path = join(worktreePath, ".agent", "issues", workItemId, "failures.md");
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildFinalCommentHtml(input: {
  outcome: "human_review" | "failed";
  reason: string;
  previewUrl: string | null;
  loop: number;
  planResult: PlanResult | null;
}): string {
  const heading = input.outcome === "human_review"
    ? `<p><strong>Ready for Human Review.</strong></p>`
    : `<p><strong>Pipeline failed after ${input.loop} loop(s).</strong></p>`;

  const branchLine = input.planResult
    ? `<p>Branch: <code>${escapeHtml(input.planResult.branch)}</code></p>`
    : "";
  const previewLine = input.previewUrl
    ? `<p>Preview: <a href="${escapeHtml(input.previewUrl)}">${escapeHtml(input.previewUrl)}</a></p>`
    : "";
  const reasonLine = `<p><em>${escapeHtml(input.reason)}</em></p>`;

  return `${heading}${branchLine}${previewLine}${reasonLine}`;
}

// FIFO tiebreak uses Plane's updated_at as a proxy for "moved to In Progress".
// Imperfect — any later edit resets it — but the Plane SDK doesn't expose a
// per-state-transition timestamp on the work item itself.
function compareIssues(a: PlaneIssue, b: PlaneIssue): number {
  const priorityDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  if (priorityDiff !== 0) return priorityDiff;
  return a.updatedAt.getTime() - b.updatedAt.getTime();
}
