export interface BuildPhasePromptInput {
  /** Plane work item UUID. */
  workItemId: string;
  /** Short identifier (e.g. "PLANE-42"). */
  shortId: string;
  sequenceId: number;
  /** Issue title. */
  title: string;
  /** Issue description, stripped of HTML. May be empty. */
  descriptionText: string;
  /** Branch the worktree is checked out on. */
  branch: string;
  /** Repo-relative path to the full plan (read for context). */
  planRelPath: string;
  /** Repo-relative path to memory.md (what prior sessions did — read-only). */
  memoryRelPath: string;
  /** Repo-relative path the agent writes its outcome report to. */
  phaseReportRelPath: string;
  /** Repo-relative path the agent writes its done flag to. */
  doneFlagRelPath: string;
  /** 1-indexed phase number. */
  phaseIndex: number;
  /** Total phases in the plan (for orientation only). */
  totalPhases: number;
  /** Phase heading title. */
  phaseTitle: string;
  /** The full phase block copied verbatim from plan.md. */
  phaseBody: string;
  /** Raw "Satisfies AC:" value for this phase (or null). */
  satisfiesAcRaw: string | null;
  /** 1-indexed attempt number for THIS phase. */
  attemptNumber: number;
  /** Notes from prior failed attempts at THIS phase (empty on attempt 1). */
  priorFailures: string;
}

/**
 * Phase 6: one fresh Claude session implements exactly one plan phase. The
 * prompt carries the whole plan (context), the running memory.md (what earlier
 * sessions did), and the specific phase block to implement. The orchestrator —
 * not the agent — commits, pushes, runs the authoritative `pnpm build`, and
 * writes the uniform phase section to memory.md, so the session is told to do
 * none of those.
 */
export function buildPhasePrompt(input: BuildPhasePromptInput): string {
  const {
    shortId,
    sequenceId,
    title,
    descriptionText,
    branch,
    planRelPath,
    memoryRelPath,
    phaseReportRelPath,
    doneFlagRelPath,
    phaseIndex,
    totalPhases,
    phaseTitle,
    phaseBody,
    satisfiesAcRaw,
    attemptNumber,
    priorFailures,
    workItemId,
  } = input;

  const description = descriptionText.trim().length > 0
    ? descriptionText.trim()
    : "(no description provided)";

  const acLine = satisfiesAcRaw && satisfiesAcRaw.trim().length > 0
    ? satisfiesAcRaw.trim()
    : "none";

  const priorFailuresBlock = priorFailures.trim().length > 0
    ? `\n# Prior attempts at THIS phase\n\nThis is attempt **${attemptNumber}** at Phase ${phaseIndex}. The earlier attempt(s) did not pass. Read carefully and fix the actual cause — do not repeat the same approach:\n\n${priorFailures.trim()}\n`
    : "";

  return `You are the **Building Agent** for the Exponential autonomous coding pipeline, working inside a fresh git worktree of the summario repo on branch \`${branch}\`. A Planning Agent wrote a phased plan; earlier sessions implemented earlier phases. **You implement exactly one phase: Phase ${phaseIndex}.**

# The issue (original human ask, for context)

- ID: ${shortId} (Plane sequence ${sequenceId})
- Title: ${title}
- Plane work item: ${workItemId}

${description}

# Context to read first

1. \`${planRelPath}\` — the full plan. Read it so you understand where Phase ${phaseIndex} sits, but **do not implement any other phase.**
2. \`${memoryRelPath}\` — the shared, append-only memory of what previous sessions already did for this issue. Read it so you don't redo or undo their work. **Do not edit memory.md** — the orchestrator owns it.
3. \`AGENTS.md\` and \`CLAUDE.md\` at the repo root — binding project conventions.

# Your phase — implement this and ONLY this

## Phase ${phaseIndex} of ${totalPhases} — ${phaseTitle}

${phaseBody}

(Satisfies AC: ${acLine})

# How to work

1. **Implement Phase ${phaseIndex}'s changes.** Stay strictly within this phase's scope. Do not start later phases, do not refactor unrelated code, do not "improve" things the phase didn't ask for.
2. **Run \`pnpm build\`** in this worktree and make it pass. \`pnpm build\` runs \`next build\`, which includes full TypeScript checking. Iterate until it's green (a few tries is fine). \`pnpm lint\` is available if you want it.
3. **Leave your changes uncommitted in the working tree.** The orchestrator stages, commits, and pushes — you do not. (Do not run \`git commit\`, \`git push\`, or open a PR.)

# Environment constraints

- **No dev server.** Do not run \`pnpm dev\` or any long-running process. Browser acceptance checks for this phase are deferred to the E2E agent, which tests the Vercel preview later. Rely on \`pnpm build\` for your own verification.
- **No \`git push\`, no \`git commit\`, no Plane API calls** — the orchestrator owns git and all Plane comments.
- **No scope beyond Phase ${phaseIndex}.** If you notice a later phase is needed first, note it in your report rather than doing it.
- If you need library docs, use \`npx ctx7@latest library "<name>" "<question>"\` then \`npx ctx7@latest docs <id> "<question>"\` instead of guessing.

# When you are done

1. Write your outcome report to \`${phaseReportRelPath}\` (the orchestrator reads it to record this phase in memory.md). Use exactly:

\`\`\`markdown
- Browser check: skipped
- Notes: <1-3 sentences: what you changed (key files), and what a human reviewer should confirm on the preview>
\`\`\`

2. Write \`${doneFlagRelPath}\` containing **one line**:
   - \`phase-ok\` — you implemented Phase ${phaseIndex} and \`pnpm build\` is green.
   - \`phase-failed\` — you could not complete Phase ${phaseIndex} or could not get \`pnpm build\` green. Put the reason in the Notes of your report.

3. Stop. The orchestrator polls for that flag, runs its own \`pnpm build\` to confirm, commits your changes, and starts the next phase in a fresh session.
${priorFailuresBlock}`;
}
