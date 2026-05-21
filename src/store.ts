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

    // Phase 2 columns. ALTER TABLE ADD COLUMN is a no-op-on-error so we just
    // ignore "duplicate column" errors when the columns already exist.
    const phase2Columns = [
      "branch_name TEXT",
      "worktree_path TEXT",
      "plan_path TEXT",
      "last_error TEXT",
    ];
    for (const col of phase2Columns) {
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
               attempts = attempts + 1
         WHERE plane_work_item_id = ?`,
      );
      update.run(
        input.name,
        input.priority,
        now,
        now,
        input.workItemId,
      );
    } else {
      const insert = this.db.prepare(
        `INSERT INTO issues (
            plane_work_item_id, workspace_slug, project_id, sequence_id,
            name, priority, status, picked_up_at, updated_at, attempts
         ) VALUES (?, ?, ?, ?, ?, ?, 'picked_up', ?, ?, 1)`,
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

  close(): void {
    this.db.close();
  }
}
