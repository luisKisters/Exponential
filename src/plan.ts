/**
 * Shared parsing for the planning agent's `plan.md`.
 *
 * Phase 2's `extractPhaseTitles` only ever pulled the heading text. Phase 6's
 * multi-session builder needs the *full* per-phase block (so it can hand one
 * phase at a time to a fresh Claude session) plus the `Satisfies AC:` mapping
 * (so the orchestrator can tick acceptance criteria without re-reading the
 * agent's claims). This module owns that richer parse; `planner.ts` reuses it.
 */

/** A single "## Phase N — title" block extracted from plan.md. */
export interface ParsedPhase {
  /** 1-indexed phase number from the heading. */
  index: number;
  /** Heading text after the dash/colon. */
  title: string;
  /** Full markdown of the phase block (everything until the next phase heading), trimmed. */
  body: string;
  /** Parsed 1-indexed AC numbers from the phase's "Satisfies AC:" line ([] when none/absent). */
  satisfiesAc: number[];
  /** Raw value after "Satisfies AC:" with any trailing HTML comment stripped (null when absent). */
  satisfiesAcRaw: string | null;
}

// Matches "## Phase 1 — Title", "## Phase 2: Title", "## Phase 3 - Title".
// `gim`: global (walk every phase), case-insensitive, multiline (^/$ per line).
const PHASE_HEADING_RE = /^##\s+Phase\s+(\d+)\s*[—:\-]\s*(.+?)\s*$/gim;

/**
 * Extract every phase block from a plan.md document. Walks heading-by-heading
 * so a malformed phase body doesn't sink the rest. Returns phases in document
 * order (which is normally also numeric order, but we don't enforce that).
 */
export function parsePlanPhases(planMarkdown: string): ParsedPhase[] {
  const matches = [...planMarkdown.matchAll(PHASE_HEADING_RE)];
  const phases: ParsedPhase[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const next = matches[i + 1];
    const bodyStart = (m.index ?? 0) + m[0].length;
    const bodyEnd = next?.index ?? planMarkdown.length;
    const body = planMarkdown.slice(bodyStart, bodyEnd).trim();
    const satisfiesAcRaw = matchSatisfiesAc(body);
    phases.push({
      index: Number(m[1]!),
      title: m[2]!.trim(),
      body,
      satisfiesAc: parseAcList(satisfiesAcRaw),
      satisfiesAcRaw,
    });
  }
  return phases;
}

/**
 * Just the phase titles, in order. Kept as a thin wrapper over
 * `parsePlanPhases` so the planner's existing call site (validation + the
 * Plane comment) doesn't need to change shape.
 */
export function extractPhaseTitles(planMarkdown: string): string[] {
  return parsePlanPhases(planMarkdown).map((p) => p.title);
}

/**
 * Pull the value out of a phase's "Satisfies AC:" line. Tolerates bold markers
 * (`**Satisfies AC:** 1, 2` or `**Satisfies AC**: 1, 2`), a leading list
 * marker, and a trailing `<!-- ... -->` comment (the plan template carries one).
 */
function matchSatisfiesAc(body: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    // Drop emphasis markers so the bold/non-bold variants collapse to one form.
    const line = rawLine.replace(/\*/g, "");
    const m = /Satisfies AC\s*:\s*(.+?)\s*$/i.exec(line);
    if (m) return m[1]!.replace(/<!--[\s\S]*?-->/g, "").trim();
  }
  return null;
}

/**
 * Parse a comma/space separated 1-indexed AC list. "none"/"n/a"/empty → [].
 * Shared by the plan parser and the builder's memory-section parser so the two
 * places that read "Satisfies AC" agree on semantics.
 */
export function parseAcList(raw: string | null): number[] {
  if (!raw) return [];
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "none" || trimmed === "n/a") return [];
  return trimmed
    .split(/[,\s]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}
