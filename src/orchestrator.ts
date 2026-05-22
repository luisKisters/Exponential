import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Builder, BuildingError, type BuildResult } from "./builder.js";
import type { Config } from "./config.js";
import { E2eRunner, type E2eResult } from "./e2e.js";
import { Git } from "./git.js";
import type { Logger } from "./logger.js";
import { PRIORITY_RANK, type PlaneApi, type PlaneIssue } from "./plane.js";
import { Planner, PlanningError, type PlanResult } from "./planner.js";
import type { IssueRow, Store } from "./store.js";
import { deriveGhRepo, waitForPreview } from "./vercel.js";

export class Orchestrator {
  private timer?: NodeJS.Timeout;
  private inFlightCycle = false;
  private inFlightPipeline?: Promise<void>;
  private stopped = false;
  private inProgressStateId: string | undefined;
  private humanReviewStateId: string | undefined;
  private failedStateId: string | undefined;
  private ghRepo: string | undefined;
  private resolveStop?: () => void;
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
      await this.plane.postComment(next.id, "<p>Picked up by Exponential.</p>");
    } catch (err) {
      this.logger.error(
        { err, workItemId: next.id },
        "failed to post pickup comment",
      );
      this.store.recordEvent(next.id, "pickup_comment_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.inFlightPipeline = this.runPipeline(next).finally(() => {
      delete this.inFlightPipeline;
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
    this.inFlightPipeline = this.continuePipeline(issue, planResult, resumeFrom)
      .finally(() => {
        delete this.inFlightPipeline;
      });
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
        planResult = await this.runPlanning(issue, {
          loopNumber: loop,
          priorFailures,
        });
        if (!planResult) return;
        stage = "build";
      }

      if (stage === "build") {
        if (!planResult) return;
        buildResult = await this.runBuilding(issue, planResult);
        if (!buildResult || !buildResult.ok) {
          await this.finishPipeline(issue, "failed", {
            reason: buildResult
              ? `build did not complete cleanly after ${buildResult.attempts} attempt(s)`
              : "building threw",
            previewUrl: null,
            planResult,
            loop,
          });
          return;
        }
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

        const previewUrl = await this.waitForPreviewSafely(issue, sha);
        if (!previewUrl) {
          await this.finishPipeline(issue, "failed", {
            reason: "vercel preview was never available",
            previewUrl: null,
            planResult,
            loop,
          });
          return;
        }

        const e2eResult = await this.runE2e(issue, planResult, previewUrl, loop, priorFailures);
        if (!e2eResult) {
          await this.finishPipeline(issue, "failed", {
            reason: "e2e session threw",
            previewUrl,
            planResult,
            loop,
          });
          return;
        }

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

  private async runPlanning(
    issue: PlaneIssue,
    opts: { loopNumber: number; priorFailures: string },
  ): Promise<PlanResult | null> {
    try {
      const result = await this.planner.plan(issue, {
        loopNumber: opts.loopNumber,
        priorFailures: opts.priorFailures,
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
      return result;
    } catch (err) {
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
        await this.plane.postComment(
          issue.id,
          `<p><strong>Planning failed (loop ${opts.loopNumber}).</strong></p><pre>${escapeHtml(message)}</pre>`,
        );
      } catch {
        // best-effort
      }
      return null;
    }
  }

  private async runBuilding(
    issue: PlaneIssue,
    planResult: PlanResult,
  ): Promise<BuildResult | null> {
    try {
      const detail = await this.plane.retrieveIssue(issue.id);
      const result = await this.builder.build({
        issue: detail,
        branch: planResult.branch,
        worktreePath: planResult.worktreePath,
        planRelPath: planResult.planPath,
      });
      this.logger.info(
        {
          workItemId: issue.id,
          sequenceId: issue.sequenceId,
          branch: planResult.branch,
          ok: result.ok,
          attempts: result.attempts,
          headSha: result.headSha?.slice(0, 12) ?? null,
          phases: result.phases.length,
          ticked: result.tickResult?.matched ?? [],
        },
        "build stage finished",
      );
      return result;
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
      return null;
    }
  }

  private async waitForPreviewSafely(
    issue: PlaneIssue,
    sha: string,
  ): Promise<string | null> {
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
      if (result.state !== "success") {
        this.logger.warn(
          { sha, state: result.state, url: result.url },
          "vercel preview did not succeed; skipping e2e",
        );
        return null;
      }
      if (!result.url) {
        this.logger.warn({ sha }, "vercel preview marked success but no url returned");
        return null;
      }
      return result.url;
    } catch (err) {
      this.logger.error({ err, sha }, "preview wait threw");
      this.store.recordEvent(issue.id, "preview_wait_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async runE2e(
    issue: PlaneIssue,
    planResult: PlanResult,
    previewUrl: string,
    loop: number,
    priorFailures: string,
  ): Promise<E2eResult | null> {
    try {
      const detail = await this.plane.retrieveIssue(issue.id);
      const result = await this.e2e.verify({
        issue: detail,
        branch: planResult.branch,
        worktreePath: planResult.worktreePath,
        previewUrl,
        loopNumber: loop,
        priorFailures,
      });
      this.logger.info(
        {
          workItemId: issue.id,
          loop,
          verdict: result.verdict,
          doneFlagSeen: result.doneFlagSeen,
          timedOut: result.timedOut,
        },
        "e2e stage finished",
      );
      return result;
    } catch (err) {
      this.logger.error({ err, workItemId: issue.id }, "e2e threw");
      this.store.recordEvent(issue.id, "e2e_threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
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
      await this.plane.postComment(
        issue.id,
        buildFinalCommentHtml({ outcome, ...input }),
      );
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
