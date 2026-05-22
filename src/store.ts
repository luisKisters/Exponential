import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "./logger.js";
import type { Priority } from "./plane.js";

// Phase 1 only uses 'picked_up'. Future phases will add more.
// Anything in TERMINAL_STATUSES means we're allowed to re-pick on next loop.
export type IssueStatus =
  | "picked_up"
  | "planning"
  | "planned"
  | "building"
  | "built"
  | "e2e_testing"
  | "human_review"
  | "failed"
  | "done";

export const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set([
  "human_review",
  "failed",
  "done",
]);

export interface IssueRow {
  plane_work_item_id: string;
  workspace_slug: string;
  project_id: string;
  sequence_id: number;
  name: string;
  priority: Priority;
  status: IssueStatus;
  picked_up_at: string;
  updated_at: string;
  attempts: number;
  branch_name: string | null;
  worktree_path: string | null;
  plan_path: string | null;
  last_error: string | null;
  summary_path: string | null;
  head_sha: string | null;
  loops: number;
  preview_url: string | null;
  /** ISO timestamp of the most recent Plane comment we've already accounted for (ours or theirs). */
  last_seen_comment_at: string | null;
  /** Reviewer feedback text waiting to be folded into the next planning loop. */
  pending_feedback: string | null;
  /** How many times we've retried a failed Vercel preview deploy for this issue. */
  preview_retry_count: number;
}

export interface PickupInsert {
  workItemId: string;
  workspaceSlug: string;
  projectId: string;
  sequenceId: number;
  name: string;
  priority: Priority;
}

export class Store {
  private readonly db: Database.Database;

  constructor(
    private readonly logger: Logger,
    path: string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        plane_work_item_id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        project_id TEXT NOT NULL,
        sequence_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        picked_up_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plane_work_item_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(plane_work_item_id);
    `);

    // Phase 2 + 3 columns. ALTER TABLE ADD COLUMN is a no-op-on-error so we
    // just ignore "duplicate column" errors when the columns already exist.
    const extraColumns = [
      "branch_name TEXT",
      "worktree_path TEXT",
      "plan_path TEXT",
      "last_error TEXT",
      "summary_path TEXT",
      "head_sha TEXT",
      "loops INTEGER NOT NULL DEFAULT 0",
      "preview_url TEXT",
      // Phase 4.5 — comment-driven revise loop bookkeeping.
      "last_seen_comment_at TEXT",
      "pending_feedback TEXT",
      // Phase 5 (slice 5a) — Vercel preview retriable resource.
      "preview_retry_count INTEGER NOT NULL DEFAULT 0",
    ];
    for (const col of extraColumns) {
      try {
        this.db.exec(`ALTER TABLE issues ADD COLUMN ${col}`);
      } catch (err) {
        if (
          err instanceof Error &&
          /duplicate column name/i.test(err.message)
        ) {
          continue;
        }
        throw err;
      }
    }

    this.logger.debug("sqlite schema ensured");
  }

  hasActiveIssue(): IssueRow | undefined {
    const placeholders = Array.from(TERMINAL_STATUSES.values())
      .map(() => "?")
      .join(",");
    const stmt = this.db.prepare(
      `SELECT * FROM issues WHERE status NOT IN (${placeholders}) LIMIT 1`,
    );
    return stmt.get(...TERMINAL_STATUSES) as IssueRow | undefined;
  }

  /**
   * Find an issue whose row was left in a resumable state (`planned` or
   * `built`) — typically because the orchestrator crashed/restarted between
   * stages. Returns the next stage to resume from.
   */
  findResumableIssue(): { row: IssueRow; resumeFrom: "build" | "e2e" } | undefined {
    const planned = this.db.prepare(
      `SELECT * FROM issues WHERE status = 'planned' LIMIT 1`,
    ).get() as IssueRow | undefined;
    if (planned) return { row: planned, resumeFrom: "build" };
    const built = this.db.prepare(
      `SELECT * FROM issues WHERE status = 'built' LIMIT 1`,
    ).get() as IssueRow | undefined;
    if (built) return { row: built, resumeFrom: "e2e" };
    return undefined;
  }

  /** Back-compat alias. */
  findPlannedIssue(): IssueRow | undefined {
    return this.db.prepare(
      `SELECT * FROM issues WHERE status = 'planned' LIMIT 1`,
    ).get() as IssueRow | undefined;
  }

  getIssue(workItemId: string): IssueRow | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM issues WHERE plane_work_item_id = ?",
    );
    return stmt.get(workItemId) as IssueRow | undefined;
  }

  /**
   * Insert a fresh pickup row. If the row already exists with a terminal status,
   * we bump attempts and reset status. Returns true if inserted/updated, false
   * if the row already exists in a non-terminal state (no-op).
   */
  recordPickup(input: PickupInsert): boolean {
    const now = new Date().toISOString();
    const existing = this.getIssue(input.workItemId);

    if (existing) {
      if (!TERMINAL_STATUSES.has(existing.status)) {
        return false;
      }
      const update = this.db.prepare(
        `UPDATE issues
           SET status = 'picked_up',
               name = ?,
               priority = ?,
               picked_up_at = ?,
               updated_at = ?,
               attempts = attempts + 1,
               last_seen_comment_at = ?,
               pending_feedback = NULL,
               preview_retry_count = 0
         WHERE plane_work_item_id = ?`,
      );
      update.run(
        input.name,
        input.priority,
        now,
        now,
        now,
        input.workItemId,
      );
    } else {
      const insert = this.db.prepare(
        `INSERT INTO issues (
            plane_work_item_id, workspace_slug, project_id, sequence_id,
            name, priority, status, picked_up_at, updated_at, attempts,
            last_seen_comment_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'picked_up', ?, ?, 1, ?)`,
      );
      insert.run(
        input.workItemId,
        input.workspaceSlug,
        input.projectId,
        input.sequenceId,
        input.name,
        input.priority,
        now,
        now,
        now,
      );
    }
    this.recordEvent(input.workItemId, "picked_up", {
      sequence_id: input.sequenceId,
      priority: input.priority,
    });
    return true;
  }

  recordEvent(
    workItemId: string,
    eventType: string,
    details?: Record<string, unknown>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO events (plane_work_item_id, event_type, details, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    stmt.run(
      workItemId,
      eventType,
      details ? JSON.stringify(details) : null,
      new Date().toISOString(),
    );
  }

  markPlanning(
    workItemId: string,
    input: { branch: string; worktreePath: string },
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'planning',
             branch_name = ?,
             worktree_path = ?,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(input.branch, input.worktreePath, now, workItemId);
  }

  markPlanned(workItemId: string, planPath: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'planned',
             plan_path = ?,
             last_error = NULL,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(planPath, now, workItemId);
  }

  markBuilding(workItemId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'building',
             last_error = NULL,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(now, workItemId);
  }

  markBuilt(
    workItemId: string,
    input: { summaryPath: string; headSha: string | null },
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'built',
             summary_path = ?,
             head_sha = ?,
             last_error = NULL,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(input.summaryPath, input.headSha, now, workItemId);
  }

  markBuildFailed(workItemId: string, error: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'failed',
             last_error = ?,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(error, now, workItemId);
  }

  markE2eTesting(
    workItemId: string,
    input: { previewUrl: string; loop: number },
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'e2e_testing',
             preview_url = ?,
             loops = ?,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(input.previewUrl, input.loop, now, workItemId);
  }

  markHumanReview(
    workItemId: string,
    input: { previewUrl: string | null },
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'human_review',
             preview_url = COALESCE(?, preview_url),
             last_error = NULL,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(input.previewUrl, now, workItemId);
  }

  markFailed(workItemId: string, error: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'failed',
             last_error = ?,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(error, now, workItemId);
  }

  /**
   * Reset an issue back to 'planning' for the next pipeline loop. Keeps the
   * branch/worktree/plan_path so the planning agent can revise the existing
   * plan rather than starting from scratch.
   */
  resetForLoop(workItemId: string, loop: number): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'picked_up',
             loops = ?,
             last_error = NULL,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(loop, now, workItemId);
  }

  markPlanningFailed(workItemId: string, error: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET status = 'failed',
             last_error = ?,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(error, now, workItemId);
  }

  /**
   * Advance the high-watermark so future comment polls ignore everything up to
   * and including `createdAt`. Used both when we post our own comment (skip
   * processing it as feedback) and when we consume a reviewer comment.
   */
  advanceCommentWatermark(workItemId: string, createdAt: Date): void {
    const iso = createdAt.toISOString();
    const stmt = this.db.prepare(
      `UPDATE issues
         SET last_seen_comment_at = CASE
              WHEN last_seen_comment_at IS NULL OR last_seen_comment_at < ? THEN ?
              ELSE last_seen_comment_at
            END
       WHERE plane_work_item_id = ?`,
    );
    stmt.run(iso, iso, workItemId);
  }

  getLastSeenCommentAt(workItemId: string): string | null {
    const row = this.db.prepare(
      `SELECT last_seen_comment_at FROM issues WHERE plane_work_item_id = ?`,
    ).get(workItemId) as { last_seen_comment_at: string | null } | undefined;
    return row?.last_seen_comment_at ?? null;
  }

  /**
   * Add reviewer feedback to the pending pile. Accumulates if multiple comments
   * come in before the next planning loop has a chance to drain them.
   */
  appendPendingFeedback(workItemId: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const existing = this.db.prepare(
      `SELECT pending_feedback FROM issues WHERE plane_work_item_id = ?`,
    ).get(workItemId) as { pending_feedback: string | null } | undefined;
    const next = existing?.pending_feedback
      ? `${existing.pending_feedback}\n\n${trimmed}`
      : trimmed;
    this.db.prepare(
      `UPDATE issues SET pending_feedback = ?, updated_at = ? WHERE plane_work_item_id = ?`,
    ).run(next, new Date().toISOString(), workItemId);
  }

  /** Read-and-clear the pending feedback in one transaction. */
  takePendingFeedback(workItemId: string): string | null {
    const tx = this.db.transaction((id: string): string | null => {
      const row = this.db.prepare(
        `SELECT pending_feedback FROM issues WHERE plane_work_item_id = ?`,
      ).get(id) as { pending_feedback: string | null } | undefined;
      const value = row?.pending_feedback ?? null;
      if (value !== null) {
        this.db.prepare(
          `UPDATE issues SET pending_feedback = NULL, updated_at = ? WHERE plane_work_item_id = ?`,
        ).run(new Date().toISOString(), id);
      }
      return value;
    });
    return tx(workItemId);
  }

  /**
   * Issues we still "own" for the purposes of comment polling. Anything that
   * has reached `done` is out — but `human_review` and `failed` stay in scope
   * so the reviewer can revise post-pipeline.
   */
  listFeedbackTargets(): IssueRow[] {
    return this.db.prepare(
      `SELECT * FROM issues WHERE status NOT IN ('done') ORDER BY updated_at DESC`,
    ).all() as IssueRow[];
  }

  /**
   * After a successful Vercel preview retry exhaustion, the orchestrator wants
   * to know "have we tried N times yet". `incrementPreviewRetry` returns the
   * new count.
   */
  incrementPreviewRetry(workItemId: string): number {
    const tx = this.db.transaction((id: string): number => {
      this.db.prepare(
        `UPDATE issues SET preview_retry_count = preview_retry_count + 1, updated_at = ? WHERE plane_work_item_id = ?`,
      ).run(new Date().toISOString(), id);
      const row = this.db.prepare(
        `SELECT preview_retry_count FROM issues WHERE plane_work_item_id = ?`,
      ).get(id) as { preview_retry_count: number } | undefined;
      return row?.preview_retry_count ?? 0;
    });
    return tx(workItemId);
  }

  resetPreviewRetry(workItemId: string): void {
    this.db.prepare(
      `UPDATE issues SET preview_retry_count = 0, updated_at = ? WHERE plane_work_item_id = ?`,
    ).run(new Date().toISOString(), workItemId);
  }

  /**
   * Reset a tracked issue (in any status) back to `picked_up` so the pipeline
   * re-enters from the plan stage. Used by the feedback loop when a reviewer
   * comments on a human_review/failed issue.
   */
  reopenForFeedback(workItemId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE issues
         SET status = 'picked_up',
             last_error = NULL,
             updated_at = ?
       WHERE plane_work_item_id = ?`,
    ).run(now, workItemId);
  }

  close(): void {
    this.db.close();
  }
}
