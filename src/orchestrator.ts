import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Builder, BuildingError, type BuildResult, type PhaseProgressEvent } from "./builder.js";
import type { Config } from "./config.js";
import {
  renderDashboardHtml,
  type DashboardModel,
  type DashboardPhase,
  type PhaseState,
} from "./dashboard.js";
import { E2eRunner, type E2eResult } from "./e2e.js";
import { buildBranchName, Git } from "./git.js";
import { buildBlobUrl } from "./github.js";
import type { Logger } from "./logger.js";
import { injectDashboardFence, removeFence } from "./planeDescription.js";
import { PRIORITY_RANK, type PlaneApi, type PlaneComment, type PlaneIssue } from "./plane.js";
import {
  Planner,
  PlanningAbortedError,
  PlanningError,
  PlanningTooVagueError,
  type PlanResult,
} from "./planner.js";
import {
  Reviewer,
  type ReviewFixupResult,
  type ReviewResult,
  type ReviewStageResult,
} from "./reviewer.js";
import type { IssueRow, Store } from "./store.js";
import {
  deriveGhRepo,
  fetchBuildLogs,
  looksLikeInfraFailure,
  waitForPreview,
  type PreviewResult,
} from "./vercel.js";

type StageOutcome<T> =
  | { ok: true; aborted: false; result: T }
  | { ok: false; aborted: true }
  | { ok: false; aborted: false; reason: string };

/** Phase 8: snapshot served by the HTTP health endpoint (see `health.ts`). */
export interface HealthSnapshot {
  /** `ok`/`starting` map to HTTP 200; `stale`/`stopped` map to 503. */
  status: "ok" | "starting" | "stale" | "stopped";
  startedAt: string | null;
  uptimeSeconds: number | null;
  lastCycleAt: string | null;
  lastCycleOk: boolean;
  inFlightIssueId: string | null;
  pollIntervalMs: number;
}

export class Orchestrator {
  private timer?: NodeJS.Timeout;
  private feedbackTimer?: NodeJS.Timeout;
  private inFlightCycle = false;
  private inFlightFeedbackTick = false;
  private inFlightPipeline?: Promise<void>;
  private inFlightIssueId: string | null = null;
  private stopped = false;
  /** Phase 8 health: when start() completed, and when the last poll cycle finished. */
  private startedAt: Date | null = null;
  private lastCycleAt: Date | null = null;
  private lastCycleOk = true;
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
  private readonly reviewer: Reviewer;
  private readonly git: Git;
  /** Phase 6.5: live dashboard model for the single in-flight issue. */
  private dashboard: DashboardModel | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly plane: PlaneApi,
    private readonly store: Store,
  ) {
    this.planner = new Planner(logger, config, plane, store);
    this.builder = new Builder(logger, config, plane, store);
    this.e2e = new E2eRunner(logger, config, store);
    this.reviewer = new Reviewer(logger, config, store);
    this.git = new Git(logger, config.summario.repoPath);
  }

  async start(): Promise<void> {
    this.startedAt = new Date();
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
    if (this.stageAborters.size > 0) {
      this.logger.info(
        { activeIssues: this.stageAborters.size },
        "aborting active claude sessions for shutdown",
      );
      for (const aborters of this.stageAborters.values()) {
        for (const ctrl of aborters) ctrl.abort();
      }
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

  /**
   * Phase 8: liveness snapshot for the HTTP health endpoint. The loop is "stale"
   * if no poll cycle has finished within 3 poll intervals (min 90s) — `runCycle`
   * fires on the timer every interval and `pollOnce` returns fast even while a
   * pipeline runs, so a missed cycle means the event loop is genuinely wedged.
   */
  getHealth(): HealthSnapshot {
    const now = Date.now();
    const staleAfterMs = Math.max(this.config.pollIntervalMs * 3, 90_000);
    let status: HealthSnapshot["status"];
    if (this.stopped) {
      status = "stopped";
    } else if (!this.startedAt || !this.lastCycleAt) {
      status = "starting";
    } else if (now - this.lastCycleAt.getTime() > staleAfterMs) {
      status = "stale";
    } else {
      status = "ok";
    }
    return {
      status,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeSeconds: this.startedAt
        ? Math.floor((now - this.startedAt.getTime()) / 1000)
        : null,
      lastCycleAt: this.lastCycleAt?.toISOString() ?? null,
      lastCycleOk: this.lastCycleOk,
      inFlightIssueId: this.inFlightIssueId,
      pollIntervalMs: this.config.pollIntervalMs,
    };
  }

  private async runCycle(): Promise<void> {
    if (this.inFlightCycle || this.stopped) return;
    this.inFlightCycle = true;
    try {
      await this.pollOnce();
      this.lastCycleOk = true;
    } catch (err) {
      this.lastCycleOk = false;
      this.logger.error({ err }, "poll cycle failed");
    } finally {
      this.lastCycleAt = new Date();
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
      this.dashboard = null;
    });
  }

  /**
   * Restart recovery: if an issue was left in a recoverable non-terminal
   * state, resume from the earliest stage that can safely reconstruct the
   * missing in-memory state. Pre-checks Plane to skip safely if the issue was
   * deleted.
   */
  private async resumeOrphans(): Promise<void> {
    const resumable = this.store.findResumableIssue();
    if (!resumable) return;
    const { row, resumeFrom } = resumable;
    if (
      !row.branch_name ||
      !row.worktree_path ||
      (resumeFrom !== "plan" && !row.plan_path)
    ) {
      this.logger.warn(
        { workItemId: row.plane_work_item_id, status: row.status },
        "resumable row is missing required branch/worktree/plan path; skipping recovery",
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
    const planResult: PlanResult | null =
      resumeFrom === "plan"
        ? null
        : {
            branch: row.branch_name,
            worktreePath: row.worktree_path,
            planPath: row.plan_path!,
            headSha: row.head_sha ?? "",
            phaseTitles: [],
            phases: [],
            prUrl: row.pr_url ?? null,
            planUrl: this.ghRepo
              ? buildBlobUrl(
                  this.ghRepo,
                  row.branch_name,
                  `.agent/issues/${row.plane_work_item_id}/plan.md`,
                )
              : null,
          };
    this.inFlightIssueId = issue.id;
    this.inFlightPipeline = this.continuePipeline(issue, planResult, resumeFrom)
      .finally(() => {
        delete this.inFlightPipeline;
        this.inFlightIssueId = null;
        this.dashboard = null;
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

  // ---------- live dashboard (Phase 6.5) ----------

  private nowUtcHm(): string {
    const d = new Date();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm} UTC`;
  }

  /** (Re)build the dashboard model for an issue from a plan result (if any). */
  private initDashboard(issue: PlaneIssue, planResult: PlanResult | null): void {
    const branch =
      planResult?.branch ?? buildBranchName(issue.sequenceId, issue.name);
    const phases: DashboardPhase[] = (planResult?.phases ?? []).map((p) => ({
      index: p.index,
      title: p.title,
      satisfiesAc: p.satisfiesAc,
      state: "pending",
    }));
    // Link sources: a fresh plan carries pr/plan URLs directly; on resume we
    // recover the PR + preview from the persisted row and rebuild the plan link
    // from the in-repo path (.agent/issues/<id>/plan.md, committed on the branch).
    const row = this.store.getIssue(issue.id);
    const planRelPath = `.agent/issues/${issue.id}/plan.md`;
    const planUrl =
      planResult?.planUrl ??
      (this.ghRepo ? buildBlobUrl(this.ghRepo, branch, planRelPath) : null);
    this.dashboard = {
      shortId: `PLANE-${issue.sequenceId}`,
      statusLabel: "Planning",
      detail: null,
      branch,
      phases,
      planRelPath,
      planUrl,
      prUrl: planResult?.prUrl ?? row?.pr_url ?? null,
      previewUrl: row?.preview_url ?? null,
      updatedAtUtc: this.nowUtcHm(),
    };
  }

  /**
   * Merge a patch into the dashboard model and rewrite the Plane description
   * fence. Best-effort — a Plane failure here must never sink the pipeline.
   */
  private async pushDashboard(
    workItemId: string,
    patch?: Partial<DashboardModel>,
  ): Promise<void> {
    if (!this.dashboard) return;
    if (patch) this.dashboard = { ...this.dashboard, ...patch };
    this.dashboard.updatedAtUtc = this.nowUtcHm();
    try {
      const detail = await this.plane.retrieveIssue(workItemId);
      const html = injectDashboardFence(
        detail.descriptionHtml ?? "",
        renderDashboardHtml(this.dashboard),
      );
      await this.plane.updateDescriptionHtml(workItemId, html);
      this.store.recordEvent(workItemId, "dashboard_synced", {
        status: this.dashboard.statusLabel,
        detail: this.dashboard.detail,
      });
    } catch (err) {
      this.logger.warn(
        { err, workItemId },
        "failed to sync dashboard fence (continuing)",
      );
    }
  }

  private setPhaseState(index: number, state: PhaseState): void {
    if (!this.dashboard) return;
    this.dashboard.phases = this.dashboard.phases.map((p) =>
      p.index === index ? { ...p, state } : p,
    );
  }

  /** Dashboard callback the builder fires as each plan phase progresses. */
  private async onBuildProgress(
    workItemId: string,
    totalPhases: number,
    event: PhaseProgressEvent,
  ): Promise<void> {
    if (event.type === "phase_start") {
      this.setPhaseState(event.index, "active");
      await this.pushDashboard(workItemId, {
        statusLabel: "Building",
        detail: `phase ${event.index}/${event.total}`,
      });
    } else if (event.type === "phase_complete") {
      this.setPhaseState(event.index, "done");
      await this.pushDashboard(workItemId, {
        statusLabel: "Building",
        detail: `phase ${event.index}/${totalPhases} complete`,
      });
    } else {
      this.setPhaseState(event.index, "failed");
      await this.pushDashboard(workItemId, {
        statusLabel: "Building",
        detail: `phase ${event.index} failed`,
      });
    }
  }

  /**
   * Full pipeline: plan → build → review → wait-preview → e2e, with up to
   * `maxLoops` iterations on E2E failure. Each loop re-runs planning with the
   * prior failure notes folded in.
   */
  private async runPipeline(issue: PlaneIssue): Promise<void> {
    await this.pipelineLoop(issue, /* planResult */ null, "plan");
  }

  /** Used by restart recovery to skip already-completed stages. */
  private async continuePipeline(
    issue: PlaneIssue,
    planResult: PlanResult | null,
    resumeFrom: "plan" | "build" | "review" | "e2e",
  ): Promise<void> {
    await this.pipelineLoop(issue, planResult, resumeFrom);
  }

  private async pipelineLoop(
    issue: PlaneIssue,
    seedPlan: PlanResult | null,
    startStage: "plan" | "build" | "review" | "e2e",
  ): Promise<void> {
    let loop = 1;
    let planResult: PlanResult | null = seedPlan;
    let buildResult: BuildResult | null = null;
    let priorFailures = "";
    let stage = startStage;
    // Phase 7: the sha E2E waits a Vercel preview for. Build sets it; the
    // review stage advances it when a fixup pushes new commits.
    let headShaForPreview: string | null = seedPlan?.headSha || null;

    // Phase 6.5: initialise the live dashboard (empty phases on resume; the
    // next planning pass repopulates them).
    this.initDashboard(issue, seedPlan);

    while (loop <= this.config.pipeline.maxLoops) {
      this.logger.info(
        { workItemId: issue.id, loop, stage },
        "pipeline loop iteration",
      );

      if (stage === "plan") {
        if (loop > 1) this.store.resetForLoop(issue.id, loop);
        priorFailures = this.foldInPendingFeedback(issue.id, priorFailures, loop);
        await this.pushDashboard(issue.id, {
          statusLabel: "Planning",
          detail: loop > 1 ? `revision ${loop}` : null,
        });
        const out = await this.runPlanning(issue, {
          loopNumber: loop,
          priorFailures,
        });
        if (out.aborted) {
          if (this.stopped) return;
          // Reviewer interrupted mid-plan. The watcher already wrote feedback
          // to pending_feedback; the next iteration drains it via
          // foldInPendingFeedback above. Do NOT advance the loop counter —
          // it isn't an E2E failure, it's a steering correction.
          stage = "plan";
          continue;
        }
        if (!out.ok) return;
        planResult = out.result;
        headShaForPreview = planResult.headSha || headShaForPreview;
        // Repopulate the dashboard's phase checklist from the fresh plan.
        this.initDashboard(issue, planResult);
        await this.pushDashboard(issue.id, {
          statusLabel: "Building",
          detail: `phase 0/${planResult.phases.length}`,
        });
        stage = "build";
      }

      if (stage === "build") {
        if (!planResult) return;
        const out = await this.runBuilding(issue, planResult);
        if (out.aborted) {
          if (this.stopped) return;
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
        headShaForPreview = buildResult.headSha || headShaForPreview;
        stage = "review";
      }

      if (stage === "review") {
        if (!planResult) return;
        await this.pushDashboard(issue.id, { statusLabel: "Review", detail: null });
        const out = await this.runReviewStage(issue, planResult, loop);
        if (out.aborted) {
          if (this.stopped) return;
          stage = "plan";
          continue;
        }
        // The review stage is a best-effort quality gate — it never hard-fails
        // the pipeline. It may advance the head sha (fixup commits) that E2E's
        // preview should target.
        if (out.headSha) headShaForPreview = out.headSha;
        stage = "e2e";
      }

      if (stage === "e2e") {
        if (!planResult) return;
        const sha = headShaForPreview || buildResult?.headSha || planResult.headSha;
        if (!sha) {
          await this.finishPipeline(issue, "failed", {
            reason: "no sha to look up vercel preview",
            previewUrl: null,
            planResult,
            loop,
          });
          return;
        }

        await this.pushDashboard(issue.id, {
          statusLabel: "E2E",
          detail: "deploying preview",
        });
        const previewOutcome = await this.waitForOrFixupPreview(
          issue,
          planResult,
          sha,
          loop,
        );
        if (previewOutcome.aborted) {
          if (this.stopped) return;
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

        await this.pushDashboard(issue.id, {
          statusLabel: "E2E",
          detail: "verifying preview",
          previewUrl,
        });
        const out = await this.runE2e(issue, planResult, previewUrl, loop, priorFailures);
        if (out.aborted) {
          if (this.stopped) return;
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
            reason: "e2e blocked (couldn't verify — see memory.md)",
            previewUrl,
            planResult,
            loop,
          });
          return;
        }

        // e2e-failed or no-verdict: accumulate context and loop back to plan.
        // memory.md is the full per-issue narrative; the tail holds the most
        // recent e2e notes, which is what the next planning loop needs most.
        const memoryContent = await readMemoryFile(planResult.worktreePath, issue.id);
        priorFailures = `## Loop ${loop} E2E failure\n\nmemory.md tail after loop ${loop}:\n\n${(memoryContent ?? "(empty)").slice(-16_000)}`;

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
        ghRepo: this.ghRepo,
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
      if (err instanceof PlanningTooVagueError) {
        // Phase 6.5: the issue has no ACs and is too thin to draft any. Per the
        // queue-safety decision we mark the SQLite row failed (so the
        // orchestrator isn't permanently blocked), but we do NOT move the Plane
        // state — the issue is "left alone" for the human to expand. We also
        // strip any dashboard fence we created so the description is untouched.
        this.logger.warn(
          { workItemId: issue.id, loop: opts.loopNumber },
          "planning bailed: description too vague to extract acceptance criteria",
        );
        this.dashboard = null;
        try {
          const detail = await this.plane.retrieveIssue(issue.id);
          const stripped = removeFence(detail.descriptionHtml ?? "");
          if (stripped !== (detail.descriptionHtml ?? "")) {
            await this.plane.updateDescriptionHtml(issue.id, stripped);
          }
        } catch {
          // best-effort
        }
        this.store.markPlanningFailed(
          issue.id,
          "description too vague to extract acceptance criteria",
        );
        this.store.recordEvent(issue.id, "planning_failed", {
          reason: "too_vague",
          loop: opts.loopNumber,
        });
        try {
          const c = await this.plane.postComment(
            issue.id,
            `<p><strong>Cannot plan this issue yet.</strong> The description is too vague to extract acceptance criteria. Please add a <code>## Acceptance Criteria</code> section or expand the description with concrete, verifiable behaviour, then move the issue back to <em>In Progress</em>.</p>`,
          );
          this.store.advanceCommentWatermark(issue.id, c.createdAt);
        } catch {
          // best-effort
        }
        return {
          ok: false,
          aborted: false,
          reason: "description too vague to extract acceptance criteria",
        };
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
        onProgress: (event) =>
          this.onBuildProgress(issue.id, planResult.phases.length, event),
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

      // Infra short-circuit: a missing env var / bad deploy key can't be fixed
      // from inside the worktree, so don't waste fixup attempts (or a Claude
      // session) on it — fail fast with a reviewer-actionable reason.
      const infra = looksLikeInfraFailure(buildLog);
      if (infra.infra) {
        this.logger.warn(
          { previewUrl, signature: infra.signature },
          "vercel build failure looks like infra/config, not code; skipping fixup",
        );
        this.store.recordEvent(issue.id, "preview_fixup_infra_skip", {
          attempt,
          signature: infra.signature,
          previewUrl,
        });
        try {
          const c = await this.plane.postComment(
            issue.id,
            `<p><strong>Vercel preview build failed</strong> on <code>${escapeHtml(sha.slice(0, 12))}</code>, and the log looks like an <strong>infrastructure/config problem</strong> (matched <code>${escapeHtml(infra.signature ?? "")}</code>) rather than a code defect. Not spawning a fixup agent — this needs a human (likely a Vercel env var). <a href="${escapeHtml(previewUrl)}">Vercel logs</a>.</p>`,
          );
          this.store.advanceCommentWatermark(issue.id, c.createdAt);
        } catch {
          // best-effort
        }
        return {
          ok: false,
          aborted: false,
          previewUrl,
          reason: `vercel build failed on infra/config (matched "${infra.signature}"); not a code defect — needs a human`,
        };
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

  // ---------- review stage (Phase 7) ----------

  /**
   * Phase 7: review hop between Build and E2E. Run an initial review; if it
   * surfaces findings, run a fixup session then re-review once. The stage is a
   * best-effort quality gate — it never hard-fails the pipeline (remaining
   * findings just stay in review.md for the human). It returns the latest
   * pushed sha so E2E's preview targets the post-fixup commit.
   */
  private async runReviewStage(
    issue: PlaneIssue,
    planResult: PlanResult,
    loop: number,
  ): Promise<ReviewStageResult> {
    let headSha: string | null = null;

    const r1 = await this.runReviewSession(issue, planResult, loop, "initial");
    if (r1.aborted) return { aborted: true, headSha: null };
    if (r1.headSha) headSha = r1.headSha;

    if (r1.verdict !== "review-findings") {
      this.store.recordEvent(issue.id, "review_clean", {
        pass: "initial",
        verdict: r1.verdict,
        findings: r1.findingsCount,
      });
      return { aborted: false, headSha };
    }

    this.store.recordEvent(issue.id, "review_findings", {
      findings: r1.findingsCount,
    });
    await this.pushDashboard(issue.id, {
      statusLabel: "Review",
      detail: "addressing findings",
    });

    const fx = await this.runReviewFixupSession(issue, planResult, loop);
    if (fx.aborted) return { aborted: true, headSha: null };
    if (fx.pushedSha) headSha = fx.pushedSha;

    await this.pushDashboard(issue.id, {
      statusLabel: "Review",
      detail: "re-checking",
    });
    const r2 = await this.runReviewSession(issue, planResult, loop, "recheck");
    if (r2.aborted) return { aborted: true, headSha: null };
    if (r2.headSha) headSha = r2.headSha;

    if (r2.verdict === "review-findings") {
      this.logger.info(
        { workItemId: issue.id, findings: r2.findingsCount },
        "review still has findings after fixup; proceeding to E2E anyway",
      );
      this.store.recordEvent(issue.id, "review_proceeding_with_findings", {
        findings: r2.findingsCount,
      });
    } else {
      this.store.recordEvent(issue.id, "review_clean_after_fixup", {
        verdict: r2.verdict,
      });
    }
    return { aborted: false, headSha };
  }

  private async runReviewSession(
    issue: PlaneIssue,
    planResult: PlanResult,
    loop: number,
    pass: "initial" | "recheck",
  ): Promise<ReviewResult> {
    const stageAbort = this.registerStageAbort(issue.id);
    try {
      const detail = await this.plane.retrieveIssue(issue.id);
      return await this.reviewer.review({
        issue: detail,
        branch: planResult.branch,
        worktreePath: planResult.worktreePath,
        planRelPath: planResult.planPath,
        loopNumber: loop,
        pass,
        signal: stageAbort.signal,
      });
    } catch (err) {
      // A review failure must not sink the pipeline — log and proceed as if
      // there were no actionable findings.
      this.logger.error(
        { err, workItemId: issue.id, pass },
        "review session threw; treating as no-verdict",
      );
      this.store.recordEvent(issue.id, "review_threw", {
        pass,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        verdict: "no-verdict",
        findingsCount: 0,
        aborted: false,
        doneFlagSeen: false,
        timedOut: false,
        headSha: null,
      };
    } finally {
      stageAbort.release();
    }
  }

  private async runReviewFixupSession(
    issue: PlaneIssue,
    planResult: PlanResult,
    loop: number,
  ): Promise<ReviewFixupResult> {
    const stageAbort = this.registerStageAbort(issue.id);
    try {
      const detail = await this.plane.retrieveIssue(issue.id);
      return await this.reviewer.fixup({
        issue: detail,
        branch: planResult.branch,
        worktreePath: planResult.worktreePath,
        planRelPath: planResult.planPath,
        loopNumber: loop,
        signal: stageAbort.signal,
      });
    } catch (err) {
      this.logger.error(
        { err, workItemId: issue.id },
        "review fixup session threw; skipping",
      );
      this.store.recordEvent(issue.id, "review_fixup_threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        verdict: "error",
        aborted: false,
        doneFlagSeen: false,
        advancedHead: false,
        newHeadSha: "",
        pushedSha: null,
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

    // Phase 6.5: flip the dashboard to its terminal status before we mutate
    // SQLite/Plane state, so the fence reflects the final outcome.
    await this.pushDashboard(issue.id, {
      statusLabel: outcome === "human_review" ? "Human Review" : "Failed",
      detail: null,
    });

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

async function readMemoryFile(
  worktreePath: string,
  workItemId: string,
): Promise<string | null> {
  const path = join(worktreePath, ".agent", "issues", workItemId, "memory.md");
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
  const prLine = input.planResult?.prUrl
    ? `<p>PR: <a href="${escapeHtml(input.planResult.prUrl)}">${escapeHtml(input.planResult.prUrl)}</a></p>`
    : "";
  const planLine = input.planResult?.planUrl
    ? `<p>Plan: <a href="${escapeHtml(input.planResult.planUrl)}">full plan on branch</a></p>`
    : "";
  const previewLine = input.previewUrl
    ? `<p>Preview: <a href="${escapeHtml(input.previewUrl)}">${escapeHtml(input.previewUrl)}</a></p>`
    : "";
  const reasonLine = `<p><em>${escapeHtml(input.reason)}</em></p>`;

  return `${heading}${branchLine}${prLine}${planLine}${previewLine}${reasonLine}`;
}

// FIFO tiebreak uses Plane's updated_at as a proxy for "moved to In Progress".
// Imperfect — any later edit resets it — but the Plane SDK doesn't expose a
// per-state-transition timestamp on the work item itself.
function compareIssues(a: PlaneIssue, b: PlaneIssue): number {
  const priorityDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  if (priorityDiff !== 0) return priorityDiff;
  return a.updatedAt.getTime() - b.updatedAt.getTime();
}
