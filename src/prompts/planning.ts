export interface PlanningPromptInput {
  /** Plane work item UUID (used for the .agent/issues/<id>/ directory). */
  workItemId: string;
  /** Short identifier used in human-facing copy (e.g. "PLANE-42"). */
  shortId: string;
  /** Plane sequence id (just the number). */
  sequenceId: number;
  /** Issue title. */
  title: string;
  /** Plain-text issue body. May be empty. */
  descriptionText: string;
  /** Path (relative to repo root) where the plan must be written. */
  planRelPath: string;
  /** Path (relative to repo root) where the agent writes the completion flag. */
  doneFlagRelPath: string;
  /** Path (relative to repo root) for the progress log. */
  progressRelPath: string;
  /** Branch name the worktree is checked out on. */
  branch: string;
  /** 1-indexed pipeline loop number. 1 = first plan, 2+ = revision after E2E failure. */
  loopNumber?: number;
  /** Notes from prior E2E failures (used when re-planning). */
  priorFailures?: string;
}

export function buildPlanningPrompt(input: PlanningPromptInput): string {
  const {
    shortId,
    title,
    descriptionText,
    planRelPath,
    doneFlagRelPath,
    progressRelPath,
    branch,
    loopNumber = 1,
    priorFailures = "",
  } = input;

  const description = descriptionText.trim().length > 0
    ? descriptionText.trim()
    : "(no description provided)";

  const revisionBlock = priorFailures.trim().length > 0
    ? `\n# Revise the plan to address the notes below\n\nThe notes may be reviewer feedback left on the Plane issue while the agent was working, an E2E failure from a prior loop, or both. Read every section carefully and revise the plan so the next build attempt addresses them — don't just re-emit the same phases. ${loopNumber > 1 ? `(Loop ${loopNumber}.)` : ""}\n\n${priorFailures.trim()}\n`
    : "";

  return `You are the **Planning Agent** for the Exponential autonomous coding pipeline. You are running inside a fresh git worktree of the summario repo, checked out on the branch \`${branch}\`.${revisionBlock}

# Your task

Produce a **phased implementation plan** for the Plane issue below. You are NOT implementing anything yet — a separate Building Agent will execute the plan you write. Focus on breaking the work into independently shippable phases, each with a clear browser-visible acceptance check.

# The issue

- ID: ${shortId} (Plane sequence ${input.sequenceId})
- Title: ${title}

Description:

${description}

# How to plan

1. Read \`AGENTS.md\` and \`CLAUDE.md\` at the repo root for project conventions.
2. Read the relevant files under \`docs/\` (architecture, conventions, runbook, product) for any context that shapes how this should be built.
3. Skim the relevant source code (\`app/\`, \`components/\`, \`convex/\`, \`lib/\`) enough to understand where the change lives and what's already there. Do NOT make any code changes.
4. If the issue touches a third-party library or framework, fetch up-to-date docs with the \`ctx7\` CLI rather than relying on your training data. Use \`npx ctx7@latest library "<name>" "<question>"\` then \`npx ctx7@latest docs <id> "<question>"\`.
5. Decompose the work into **2–6 phases**. Each phase must:
   - Be independently mergeable in principle (no half-broken UI).
   - End with a concrete browser-observable behavior the user can verify.
   - Specify what files / modules are likely to change (best-effort, not binding).
   - Include a **Browser acceptance check** written in natural language that describes the *intent* of what to verify, not exact selectors or strict click-by-click instructions. The Building Agent and E2E Agent should both be able to follow it loosely.
   - Include a **Satisfies AC** line listing the 1-indexed bullet numbers from the issue's \`## Acceptance Criteria\` section that this phase, once green, demonstrably satisfies. Use \`none\` if the phase doesn't tick any AC (e.g. a refactor-only phase). If the issue has no \`## Acceptance Criteria\` section, use \`none\` for every phase. Do NOT invent AC numbers that don't exist.

# Output

Write the plan to **exactly** \`${planRelPath}\` (relative to the repo root). Use this template:

\`\`\`markdown
# ${shortId} — ${title}

## Overview

One short paragraph: what this issue is asking for and the overall approach.

## Open assumptions

Anything you couldn't fully resolve from the codebase / issue. The Building Agent will treat these as starting points.

## Phase 1 — <short title>

**Goal:** one-line description.

**Likely changes:**
- file or area
- file or area

**Satisfies AC:** 1, 2   <!-- or \`none\` -->

**Browser acceptance check:**
What a person opening the preview should be able to do/see to know this phase is working. Describe intent, not exact steps.

## Phase 2 — <short title>

(same structure)

...
\`\`\`

# Per-issue memory

You may also append helpful context to \`${progressRelPath}\` (e.g. things the Building Agent should know but that don't belong in the plan itself). This file may not exist yet — create it if useful.

# When you are done

After you have written \`${planRelPath}\` and reviewed it once for completeness, write the file \`${doneFlagRelPath}\` containing a single line:

\`plan-ready\`

Then stop. The orchestrator polls for that flag file and will close this session as soon as it appears. Do NOT commit, push, or open a PR — the orchestrator handles git afterwards.

# Constraints

- No code changes outside of the \`.agent/issues/${input.workItemId}/\` directory.
- No long shell commands; \`ctx7\` is OK.
- If the issue is too ambiguous to plan, still produce the best plan you can and list the ambiguities in **Open assumptions** so the Building Agent / human reviewer can resolve them.
`;
}
