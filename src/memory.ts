/**
 * Helpers for the per-issue `memory.md` — the single append-only narrative log
 * introduced by Phase 5 slice 5c (it replaces the old progress.md + failures.md
 * pair). Every session (planning, each phase build, e2e loop, fixup) appends a
 * section here; the orchestrator owns the per-phase build sections so their
 * format stays uniform and machine-parseable (see builder.parsePhaseOutcomes).
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { PhaseOutcome } from "./builder.js";

/**
 * Render a build phase's outcome as the uniform `## Phase N` section the
 * orchestrator writes to memory.md. The field labels match what
 * `parsePhaseOutcomes` reads back, so this round-trips. `session` is a distinct
 * per-session marker (so memory.md visibly shows each phase was authored by its
 * own Claude session). Notes are collapsed to a single line to keep the
 * `- Notes:` field parseable.
 */
export function formatPhaseSection(outcome: PhaseOutcome, session: string): string {
  const ac = outcome.satisfiesAc.length > 0 ? outcome.satisfiesAc.join(", ") : "none";
  const notes = outcome.notes.replace(/\s+/g, " ").trim();
  return [
    `## Phase ${outcome.index} — ${outcome.title}`,
    ``,
    `- Status: ${outcome.status}`,
    `- Attempts: ${outcome.attempts}`,
    `- Satisfies AC: ${ac}`,
    `- Browser check: ${outcome.browserCheck}`,
    `- Session: ${session}`,
    `- Notes: ${notes.length > 0 ? notes : "(none)"}`,
    ``,
  ].join("\n");
}

/**
 * Append a section to memory.md, guaranteeing a blank line between sections.
 * Creates the file if it doesn't exist. No-ops on an empty section.
 */
export async function appendMemorySection(memoryPath: string, section: string): Promise<void> {
  const body = section.trim();
  if (body.length === 0) return;
  let existing = "";
  try {
    existing = await readFile(memoryPath, "utf8");
  } catch {
    // memory.md doesn't exist yet — start fresh.
  }
  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(memoryPath, `${existing}${sep}${body}\n`);
}

/**
 * Make sure memory.md exists with a small header before the first phase session
 * reads it. Idempotent — leaves an existing file (e.g. one the planner already
 * seeded) untouched.
 */
export async function ensureMemoryFile(memoryPath: string, shortId: string): Promise<void> {
  if (existsSync(memoryPath)) return;
  await writeFile(
    memoryPath,
    `# ${shortId} — issue memory\n\nAppend-only narrative log across every session (planning, phase builds, e2e, fixups) for this issue.\n`,
  );
}
