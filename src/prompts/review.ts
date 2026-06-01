export interface ReviewPromptInput {
  workItemId: string;
  shortId: string;
  sequenceId: number;
  title: string;
  descriptionText: string;
  branch: string;
  /** Base branch the diff is taken against (e.g. "main"). */
  baseBranch: string;
  /** Repo-relative paths. */
  planRelPath: string;
  reviewRelPath: string;
  doneFlagRelPath: string;
  /** 1-indexed pipeline loop number. */
  loopNumber: number;
  /** "initial" or "recheck" — recheck runs after a fixup session. */
  pass: "initial" | "recheck";
}

/**
 * Phase 7: a fresh reviewer session reads the diff cold — no implementation
 * context — and judges it against the plan and the original issue. Output is a
 * structured `review.md`; a separate fixup session addresses the findings.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const {
    shortId,
    sequenceId,
    title,
    descriptionText,
    branch,
    baseBranch,
    planRelPath,
    reviewRelPath,
    doneFlagRelPath,
    loopNumber,
    pass,
    workItemId,
  } = input;

  const description = descriptionText.trim().length > 0
    ? descriptionText.trim()
    : "(no description provided)";

  const passBlock = pass === "recheck"
    ? `\n# This is a RE-CHECK\n\nA previous review found issues and a fixup session attempted to address them. Review the **current** diff again. Only report findings that are still present (or newly introduced by the fixup). If the fixup resolved everything actionable, say so with \`review-clean\`. Do not re-report findings the fixup already fixed.\n`
    : "";

  return `You are the **Code Review Agent** for the Exponential autonomous coding pipeline. A Building Agent implemented a plan across several phases on branch \`${branch}\`. Your job is to review that diff **cold** — you did not write it — and surface concrete problems a human reviewer would otherwise have to catch.${passBlock}

# The original issue (the bar the change must meet)

- ID: ${shortId} (Plane sequence ${sequenceId})
- Title: ${title}
- Plane work item: ${workItemId}

${description}

# How to review

1. Read \`${planRelPath}\` to understand the intended phased approach.
2. Inspect the actual diff against the base branch:
   - \`git diff ${baseBranch}...HEAD\` for the full change, and \`git diff ${baseBranch}...HEAD --stat\` for the file list.
   - \`git log --oneline ${baseBranch}..HEAD\` to see the per-phase commits.
3. Read the changed files in full where the diff alone is ambiguous.
4. Judge the change against the issue intent AND general correctness. Look for, in priority order:
   - **Correctness bugs** — logic errors, wrong conditionals, off-by-one, unhandled null/undefined, broken async, race conditions.
   - **Regressions** — behaviour the change breaks elsewhere; removed/altered code paths other features rely on.
   - **Type holes** — \`as any\`, \`@ts-ignore\`, unsafe casts, \`!\` non-null assertions hiding real nulls.
   - **Swallowed errors** — empty catch blocks, ignored promise rejections.
   - **Out-of-scope changes** — edits unrelated to the issue / plan that shouldn't be in this PR.
5. **Skip nits.** No style/formatting/naming preferences, no "could be cleaner" without a concrete defect. Only report things worth a human's attention.

# Output protocol

Write your findings to **exactly** \`${reviewRelPath}\` (relative to repo root). Use this structure — one \`### Finding N\` heading per finding (the orchestrator counts these):

\`\`\`markdown
# ${shortId} — review (loop ${loopNumber}, ${pass})

## Summary
One or two sentences on the overall state of the change.

### Finding 1 — <high|medium|low> — <path/to/file.ts:line>
- Problem: <what's wrong and why it matters>
- Suggested fix: <concrete change>

### Finding 2 — ...
\`\`\`

If you find **no** actionable problems, still write \`${reviewRelPath}\` with the \`## Summary\` section and the line \`No actionable findings.\` under it (no \`### Finding\` headings).

Then write \`${doneFlagRelPath}\` containing exactly one line:

- \`review-clean\` — no actionable findings.
- \`review-findings\` — one or more \`### Finding\` entries in \`${reviewRelPath}\`.

Then stop. The orchestrator polls for that flag, commits \`${reviewRelPath}\` to the branch, and (if there are findings) spawns a fixup session.

# Hard constraints

- **Do not modify source code.** You are read-only except for \`${reviewRelPath}\` and \`${doneFlagRelPath}\`.
- **Do not commit, push, or call git write commands.** The orchestrator owns git.
- **Do not call the Plane API.**
- Be specific: every finding must name a file and (where possible) a line, and describe a concrete defect — not a vibe.
`;
}
