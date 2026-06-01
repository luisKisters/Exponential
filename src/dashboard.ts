/**
 * Phase 6.5: the live status dashboard that lives inside the Plane description
 * fence. It replaces the old full-plan HTML dump with a compact header + a
 * per-phase checklist that the orchestrator rewrites on every stage transition.
 *
 * The orchestrator owns the `DashboardModel` end-to-end (one per in-flight
 * issue, since the pipeline runs one issue at a time). This module is pure
 * rendering — no Plane calls, no clock reads — so it stays trivially testable.
 * The fence placement itself lives in `planeDescription.injectDashboardFence`.
 */

export type PhaseState = "pending" | "active" | "done" | "failed";

export interface DashboardPhase {
  /** 1-indexed phase number from plan.md. */
  index: number;
  title: string;
  /** 1-indexed AC numbers this phase satisfies (for the inline label only). */
  satisfiesAc: number[];
  state: PhaseState;
}

export interface DashboardModel {
  /** e.g. "PLANE-42". */
  shortId: string;
  /** Coarse stage word: Planning | Building | Review | E2E | Human Review | Failed. */
  statusLabel: string;
  /** Optional sub-detail, e.g. "phase 2/3". Null when not applicable. */
  detail: string | null;
  branch: string;
  phases: DashboardPhase[];
  /** Repo-relative path to the full plan on the branch. */
  planRelPath: string;
  /** Pre-formatted "HH:MM UTC" timestamp (the caller owns the clock). */
  updatedAtUtc: string;
}

const CHECK = "☑"; // ☑
const EMPTY = "☐"; // ☐
const CROSS = "☒"; // ☒

function symbolFor(state: PhaseState): string {
  switch (state) {
    case "done":
      return CHECK;
    case "failed":
      return CROSS;
    default:
      return EMPTY;
  }
}

/**
 * Render the dashboard as the small HTML subset Plane accepts. Mirrors the
 * shape described in the PRD:
 *
 *   **Status:** Building — phase 2/3 · branch `…` · updated 14:02 UTC
 *   **Phases**
 *   - [x] Phase 1 — … (AC 1)
 *   - [ ] Phase 2 — … (AC 2) ← active
 *   Full plan: `…/plan.md` on branch `…`.
 *
 * Phase rows use plain ☑/☐/☒ glyphs (not real checkboxes) on purpose: the
 * tickable human-facing AC list lives ABOVE the fence and must stay the only
 * thing `tickAcceptanceCriteria` can match.
 */
export function renderDashboardHtml(model: DashboardModel): string {
  const statusText = model.detail
    ? `${escapeHtml(model.statusLabel)} — ${escapeHtml(model.detail)}`
    : escapeHtml(model.statusLabel);

  const statusLine =
    `<p><strong>Status:</strong> ${statusText} · branch <code>${escapeHtml(model.branch)}</code>` +
    ` · updated ${escapeHtml(model.updatedAtUtc)}</p>`;

  let phasesBlock: string;
  if (model.phases.length === 0) {
    phasesBlock = `<p><em>Plan not yet available.</em></p>`;
  } else {
    const rows = model.phases
      .map((p) => {
        const ac =
          p.satisfiesAc.length > 0 ? ` (AC ${p.satisfiesAc.join(", ")})` : "";
        const active = p.state === "active" ? " ← active" : "";
        return `<li>${symbolFor(p.state)} Phase ${p.index} — ${escapeHtml(p.title)}${escapeHtml(ac)}${active}</li>`;
      })
      .join("");
    phasesBlock = `<p><strong>Phases</strong></p><ul>${rows}</ul>`;
  }

  const planLine = `<p>Full plan: <code>${escapeHtml(model.planRelPath)}</code> on branch <code>${escapeHtml(model.branch)}</code>.</p>`;

  return `${statusLine}${phasesBlock}${planLine}`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
