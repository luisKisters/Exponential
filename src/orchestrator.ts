import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { PRIORITY_RANK, type PlaneApi, type PlaneIssue } from "./plane.js";
import { Planner, PlanningError } from "./planner.js";
import type { Store } from "./store.js";

export class Orchestrator {
  private timer?: NodeJS.Timeout;
  private inFlightCycle = false;
  private inFlightPlanning?: Promise<void>;
  private stopped = false;
  private inProgressStateId?: string;
  private resolveStop?: () => void;
  private readonly planner: Planner;

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly plane: PlaneApi,
    private readonly store: Store,
  ) {
    this.planner = new Planner(logger, config, plane, store);
  }

  async start(): Promise<void> {
    await this.planner.ensureReady();
    this.inProgressStateId = await this.plane.findStateIdByName(
      this.config.plane.inProgressStatus,
    );
    this.logger.info(
      {
        stateName: this.config.plane.inProgressStatus,
        stateId: this.inProgressStateId,
        pollIntervalMs: this.config.pollIntervalMs,
        summarioRepo: this.config.summario.repoPath,
      },
      "orchestrator started",
    );
    // Run an immediate cycle, then schedule recurring polls.
    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      delete this.timer;
    }
    if (this.inFlightCycle) {
      this.logger.info("waiting for in-flight poll cycle to finish");
      await new Promise<void>((resolve) => {
        this.resolveStop = resolve;
      });
    }
    if (this.inFlightPlanning) {
      this.logger.info("waiting for in-flight planning run to finish");
      try {
        await this.inFlightPlanning;
      } catch (err) {
        this.logger.error({ err }, "in-flight planning errored during shutdown");
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

    const candidates = await this.plane.listIssuesByState(
      this.inProgressStateId,
    );

    const fresh = candidates.filter((issue) => {
      const row = this.store.getIssue(issue.id);
      // Only pick truly new issues. Anything we've ever seen — including
      // 'failed', 'human_review', and 'done' — stays alone until the user
      // explicitly clears the SQLite row (or, later, an external state machine
      // signals retry). Without this guard a failed planning run would loop
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
      await this.plane.postComment(
        next.id,
        "<p>Picked up by Exponential.</p>",
      );
    } catch (err) {
      this.logger.error(
        { err, workItemId: next.id },
        "failed to post pickup comment",
      );
      this.store.recordEvent(next.id, "pickup_comment_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.inFlightPlanning = this.runPlanning(next).finally(() => {
      delete this.inFlightPlanning;
    });
  }

  private async runPlanning(issue: PlaneIssue): Promise<void> {
    try {
      const result = await this.planner.plan(issue);
      this.logger.info(
        {
          workItemId: issue.id,
          sequenceId: issue.sequenceId,
          branch: result.branch,
          phases: result.phaseTitles.length,
          headSha: result.headSha.slice(0, 12),
        },
        "planning complete",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        {
          err,
          workItemId: issue.id,
          sequenceId: issue.sequenceId,
        },
        "planning failed",
      );
      this.store.markPlanningFailed(issue.id, message);
      this.store.recordEvent(issue.id, "planning_failed", {
        error: message,
        details: err instanceof PlanningError ? {
          worktreePath: err.details.worktreePath,
          branch: err.details.branch,
        } : undefined,
      });
      try {
        await this.plane.postComment(
          issue.id,
          `<p><strong>Planning failed.</strong></p><pre>${escapeHtml(message)}</pre>`,
        );
      } catch (commentErr) {
        this.logger.error(
          { err: commentErr, workItemId: issue.id },
          "failed to post planning failure comment",
        );
      }
    }
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

// FIFO tiebreak uses Plane's updated_at as a proxy for "moved to In Progress".
// Imperfect — any later edit resets it — but the Plane SDK doesn't expose a
// per-state-transition timestamp on the work item itself.
function compareIssues(a: PlaneIssue, b: PlaneIssue): number {
  const priorityDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  if (priorityDiff !== 0) return priorityDiff;
  return a.updatedAt.getTime() - b.updatedAt.getTime();
}
