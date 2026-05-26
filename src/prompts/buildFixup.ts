export interface BuildFixupPromptInput {
  workItemId: string;
  shortId: string;
  sequenceId: number;
  title: string;
  descriptionText: string;
  branch: string;
  /** Repo-relative paths. */
  planRelPath: string;
  /** Single per-issue narrative log (Phase 5 slice 5c). */
  memoryRelPath: string;
  doneFlagRelPath: string;
  /** 1-indexed fixup attempt number. */
  attemptNumber: number;
  /** The Vercel deployment URL whose build log is included below. */
  previewUrl: string;
  /** Build log tail captured via `npx vercel inspect --logs`. */
  buildLog: string;
  /** Notes from prior fixup attempts (empty on attempt 1). */
  priorFailures: string;
}

export function buildFixupPrompt(input: BuildFixupPromptInput): string {
  const {
    shortId,
    sequenceId,
    title,
    descriptionText,
    branch,
    planRelPath,
    memoryRelPath,
    doneFlagRelPath,
    attemptNumber,
    previewUrl,
    buildLog,
    priorFailures,
    workItemId,
  } = input;

  const description = descriptionText.trim().length > 0
    ? descriptionText.trim()
    : "(no description provided)";

  const priorFailuresBlock = priorFailures.trim().length > 0
    ? `\n# Prior fixup attempt notes\n\nThis is fixup attempt **${attemptNumber}**. Earlier fixups tried and failed for the reasons below. Read carefully; do not repeat the same fix.\n\n${priorFailures.trim()}\n`
    : "";

  return `You are the **Vercel Build Fixup Agent** for the Exponential autonomous coding pipeline. The Building Agent shipped code that passed \`pnpm build\` locally, but the Vercel preview deploy for that commit **failed**. Your job is to diagnose the failure from the deploy log, fix the root cause in the code, and commit the fix so Vercel can re-build.

# The issue

- ID: ${shortId} (Plane sequence ${sequenceId})
- Title: ${title}
- Plane work item: ${workItemId}
- Branch: \`${branch}\`
- Failed preview URL: ${previewUrl}

Original description (for context — the implementation is already done; you are only fixing the build):

${description}

# The Vercel build log (last ~50 KB)

\`\`\`
${buildLog || "(no log captured — investigate plan.md + recent commits instead)"}
\`\`\`

# Workflow

1. Read \`${planRelPath}\` and \`${memoryRelPath}\` to understand what the Building Agent did. Skim \`git log --oneline -10\` to see the per-phase commits on this branch.
2. Read the build log above. Identify the **specific root cause**: a missing import, a type mismatch, a Next.js / Convex / Tailwind misuse, a stale lockfile, etc. Don't guess — find the actual error.
3. Fix it in the source. Stay minimal — touch only what is required to make the build green. Do not refactor, do not add scope.
4. Run \`pnpm build\` locally in this worktree to confirm green. If it still fails, iterate up to 3 internal tries within this session before giving up.
5. Commit your change with message:

   \`fix(${shortId}): vercel build attempt ${attemptNumber} — <one-line cause>\`

   One commit total for the fixup is ideal.

# Output protocol

When you finish (success OR failure):

1. Append a section to \`${memoryRelPath}\` like:

\`\`\`markdown
## Fixup attempt ${attemptNumber}
- Root cause: <one or two sentences>
- Fix: <what you changed, file:line>
- pnpm build: green | failed
\`\`\`

2. Write \`${doneFlagRelPath}\` containing one line:
   - \`fixup-ok\` — root cause identified, code fixed, \`pnpm build\` green, change committed.
   - \`fixup-failed\` — could not diagnose or could not get \`pnpm build\` green after retries.

Then stop. The orchestrator polls for that flag, pushes your commit (so Vercel re-deploys), and decides whether to keep looping.
${priorFailuresBlock}
# Hard constraints

- **Do not push** — the orchestrator owns \`git push\`.
- **Do not call Plane** — the orchestrator posts comments.
- **Do not change scope** — your job is to make the existing change buildable, not to re-implement or refactor.
- **Do not bypass build errors** with \`// @ts-ignore\`, \`eslint-disable\`, \`as any\` etc. unless there is no other option and you note it in the failure section above.
- If the root cause is **infrastructure** (missing env var, broken Vercel project config, expired keys) and not a code defect, write \`fixup-failed\` with a note explaining that the orchestrator cannot fix it from inside the worktree. Do not invent a code workaround.
`;
}
