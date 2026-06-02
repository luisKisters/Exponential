# Exponential — PRD

Autonomous agent orchestrator that turns Plane issues into shipped code.

**Repo:** `exponential` (new, separate from summario)
**Target project:** summario (web app, Convex backend, Next.js frontend, pnpm)
**Dependency:** summario agent readiness PRD (mock test user + project memory files) must be done before Phase 4

---

## How it works

```
Plane "In Progress" → Orchestrator polls → Planning Agent → Building Agent → E2E Agent → "Human Review"
```

1. I move a Plane issue to "In Progress"
2. Orchestrator polls Plane, picks the highest-priority issue (FIFO tiebreak)
3. **Planning agent** reads the issue and writes a phased implementation plan
4. **Building agent** implements each phase, testing locally (typecheck, build, browser) as it goes
5. Branch pushed → Vercel deploys a preview
6. **E2E agent** independently verifies the original issue's intent against the Vercel preview
7. Pass → "Human Review". Fail → loops back to planning (max 3 retries, then "Failed")
8. I review the preview URL, approve, GitHub merge queue handles the rest

One issue at a time. No concurrency.

---

## Infrastructure

- **Server:** shared, ~8 GB RAM available, 2 cores @ 3.4 GHz, 1.2 TB disk. Deployed via Coolify (Docker).
- **Auth:** Claude Code Max plan, `claude auth login` on server. Plane, GitHub, Vercel CLIs already authenticated.
- **Plane:** self-hosted, full API access.
- **Convex:** agents use prod deployment (no real users besides me, acceptable for now).
- **Dev server:** `pnpm dev` runs directly on host in a git worktree.
- **Browser:** agent-browser headless mode.
- **Vercel previews:** any non-main branch push creates a preview URL. Use `x-vercel-protection-bypass` header.

---

## Plane configuration

### Statuses

| Status | Meaning |
|---|---|
| Backlog | Ideas, not ready |
| Todo | Specified, not yet handed to agents |
| In Progress | Ready for agent pickup (triggers queue) |
| Human Review | Agent work done, waiting for manual review |
| Merging | Approved, in GitHub merge queue |
| Done | Merged into main |
| Failed | Agent failed after 3 retry loops |

### Issue template

```
## Goal
What needs to be done and why.

## Acceptance Criteria
- [ ] Concrete, verifiable criteria

## Browser Verification
Route: /example-route
Steps:
1. ...
Expected result: ...

## Notes / Constraints
Anything the agent should know.
```

---

## Agent roles

### Planning Agent

**Input:** Plane issue (goal, acceptance criteria, browser verification steps)
**Output:** Phased plan written to `.agent/issues/PLANE-{id}/plan.md`

- Reads the issue + project memory (AGENTS.md, docs/)
- Uses Context7 for relevant library docs
- Breaks the issue into phases, each with a loose but meaningful browser acceptance check
- Browser checks described in natural language — flexible on implementation details, specific on intent

### Building Agent

**Input:** Plan from planning agent + project memory
**Output:** Implemented code on feature branch, all phases tested locally

- Creates branch: `agent/PLANE-{id}-{short-title}`
- Creates git worktree at `/workspaces/PLANE-{id}/`
- Starts `pnpm dev` on an available port
- Implements each phase sequentially, after each: typecheck → build → browser check
- 3 retries per phase on failure, then hands back to planning with failure notes
- On success: commit, push, write summary, post Plane comment
- Uses mock test user, cleans up dev server after

### E2E Agent

**Input:** Original Plane issue + per-issue memory + Vercel preview URL
**Output:** Pass/fail verdict with reasoning

- Waits for Vercel preview deployment to complete
- Tests against the **original issue intent**, not the building agent's claims
- Uses mock test user via the preview with `x-vercel-protection-bypass` header
- On failure: detailed notes to memory, triggers planning revision
- On success: moves to "Human Review"

---

## Memory architecture

### Project memory (lives in summario repo)

```
AGENTS.md, CLAUDE.md, docs/architecture.md, docs/conventions.md, docs/runbook.md, docs/product.md
```

### Per-issue memory (lives on the feature branch)

```
.agent/issues/PLANE-{id}/
  plan.md       — planning agent's phased plan
  memory.md     — append-only narrative log across every session (planning, each phase build, review, e2e, fixups)
  review.md     — Phase 7 code-review findings (rewritten each review pass)
  summary.md    — final human-facing summary after completion
  done.flag     — transient per-session completion signal (never committed)
  ac-draft.md   — Phase 6.5 auto-drafted acceptance criteria (only when the human left none)
```

`memory.md` (Phase 5 slice 5c) replaced the old `progress.md` + `failures.md`
pair: one file, one append-only narrative. The per-phase build sections are
written by the orchestrator (parsed from each phase session's report) so their
format is uniform; every other session (planning, e2e, fixup) appends its own
section.

---

## Merge strategy

GitHub merge queue, no merge agent. Branch protection on summario's `main`:
- Require PR
- Require status checks (typecheck, build)
- Enable merge queue (squash merge)

---

## Phases

Each phase is independently executable by an agent. Between phases, context can be cleared — `memory.md` carries forward what was done and what's next.

### Phase 1: Orchestrator Core

Scaffold the project and get it polling Plane.

**What to build:**
- New TypeScript project with Docker setup (Node.js, pnpm or npm)
- Plane API client: poll issues by status, read issue details, update status, post comments
- SQLite state store (better-sqlite3 or similar): track runs, queue state, timestamps
- Poll loop: configurable interval (default 30s), check for "In Progress" issues
- Queue logic: sort by Plane priority (Urgent > High > Medium > Low > None), FIFO tiebreak by `moved_to_in_progress` timestamp
- Pick one unstarted issue per cycle
- Post "Picked up by Exponential" comment on pickup
- Structured logging to stdout
- Graceful shutdown (SIGTERM handling)

**Acceptance test:**
- Start the orchestrator pointing at the Plane instance
- Create a test issue in Plane, move to "In Progress"
- Orchestrator picks it up within one poll cycle, logs the issue
- Comment appears on the Plane issue
- Issue recorded in SQLite with timestamp and status
- A second issue in "In Progress" with lower priority is not picked up while the first is running

---

### Phase 2: Planning Agent ✅

Wire the planning agent into the orchestrator.

**What was built:**
- Planning agent prompt template (`src/prompts/planning.ts`): instructs Claude Code to read AGENTS.md / CLAUDE.md / docs/, skim relevant source, use `ctx7` for library docs, and output a phased plan with browser-observable acceptance checks per phase.
- Orchestrator integration: spawn the Claude Code CLI **interactively** via `node-pty` (`src/claude.ts`). `claude -p` was avoided because it hits Max-plan rate limits; the prompt is passed as a positional CLI argument (initial user message), and the agent signals completion by writing `.agent/issues/<id>/done.flag`, which the orchestrator polls for. On detection, `/exit\r` is written to the pty, with SIGTERM (15 s) and SIGKILL (25 s) as fallbacks.
- Required env var `SUMMARIO_REPO_PATH` points at an existing local clone of summario (for local dev this is a symlink to a working dev clone so `.env`/`node_modules` come along; for Phase 5 it will be a Docker volume).
- For each pickup: `git fetch`, then `git worktree add <WORKTREE_BASE_PATH>/PLANE-<seq>/ -b agent/PLANE-<seq>-<slug> origin/main`. Phase 3 will reuse the same worktree path.
- After the agent finishes: orchestrator removes `done.flag`, runs `git commit -am "chore(plan): …"`, then `git push -u origin agent/PLANE-<seq>-<slug>`.
- Posts a Plane comment listing the phase titles, branch, plan path, and commit sha.
- SQLite gains `branch_name`, `worktree_path`, `plan_path`, `last_error` columns plus `markPlanning` / `markPlanned` / `markPlanningFailed` transitions.

**Acceptance test:**
- Create an issue with goal + acceptance criteria + browser verification
- Move to "In Progress"
- Orchestrator picks it up, spawns planning agent
- Feature branch exists on the remote with `plan.md` containing multiple phases
- Each phase has: title, what to implement, browser acceptance check in natural language
- Plane comment shows the plan summary

**Permission mode:** the Claude session is spawned with `--permission-mode bypassPermissions` by default (overridable via `CLAUDE_EXTRA_ARGS`), because the unattended pty has nobody to answer the TUI's y/n approval prompts.

---

### Phase 3: Building Agent

Wire the building agent into the orchestrator.

**What to build:**
- Building agent system prompt template: instructs Claude Code to read the plan, implement each phase, run typecheck/build/browser checks
- Git worktree management: `git worktree add /workspaces/PLANE-{id}/ agent/PLANE-{id}-{short-title}`, cleanup on completion
- Dev server lifecycle: spawn `pnpm dev` in the worktree, detect when ready (port listening), kill on completion
- Port allocation: find an available port (start at 3001, increment)
- Phase-by-phase execution: the building agent prompt includes the full plan and instructions to implement sequentially with checks after each phase
- Retry logic: if Claude Code exits with failures noted in per-issue memory, re-invoke up to 3 times with the failure context included in the prompt
- On success: ensure all changes committed and pushed, write summary to `.agent/issues/PLANE-{id}/summary.md`, post Plane comment
- On failure after 3 retries: write failure details, signal to orchestrator
- **Plane description sync:** before the first phase starts, write the plan into the issue **description** (not a comment) so a reviewer can see the plan at the top of the issue without scrolling through comments. To avoid stomping on the human's original ask, the orchestrator owns a fenced block delimited by sentinel HTML comments and only ever rewrites what's inside it:
  ```html
  <!-- exponential:plan v1 start -->
  …current plan markdown rendered as HTML…
  <!-- exponential:plan v1 end -->
  ```
  If the sentinels don't exist yet, append them to the end of the description. The human-authored text outside the fence is never touched.
- **Acceptance-criteria check-off:** as each phase of the plan finishes building (typecheck + build + browser-check all green), the orchestrator parses the `## Acceptance Criteria` section of the issue description, identifies which AC bullets the just-finished phase satisfies, and toggles `- [ ]` → `- [x]` for those bullets. Mapping is driven by an explicit `Satisfies AC: …` line that each phase in `plan.md` is expected to carry — this means the planning-prompt template (currently in `src/prompts/planning.ts`) needs a small extension as part of Phase 3 work to instruct the agent to emit that line. Phase 2's already-shipped behaviour is otherwise unchanged. If a phase's `Satisfies AC:` references a bullet that doesn't textually exist in the description, log a warning and skip silently — don't fail the build over a stale mapping.

**Acceptance test:**
- Given an issue with a completed plan (from Phase 2), trigger the building agent
- Worktree created, dev server starts on a non-conflicting port
- Code is implemented on the feature branch
- `pnpm typecheck` passes
- `pnpm build` passes
- Branch is pushed to GitHub
- Vercel preview deployment starts (visible in GitHub commit statuses)
- Plane comment shows what was built
- **Plane description now contains the plan inside the `<!-- exponential:plan … -->` fence, and the human's original ask above the fence is unchanged byte-for-byte.**
- **At least one acceptance-criteria checkbox is now `- [x]` (assuming the issue had ACs and the plan mapped to them).**
- Worktree and dev server cleaned up

---

### Phase 4: E2E Agent + Full Pipeline

Wire the E2E agent and connect the full pipeline with failure loops.

**What to build:**
- E2E agent system prompt template: instructs Claude Code to read the original issue + memory, then independently test the Vercel preview
- Vercel preview URL detection: poll Vercel API or GitHub deployment statuses until the preview is ready (with timeout)
- `x-vercel-protection-bypass` header: pass to the E2E agent prompt so it configures agent-browser with the header
- Pass/fail logic: E2E agent writes its verdict to `.agent/issues/PLANE-{id}/verdict.txt` (+ `done.flag`) and observations to `memory.md`; orchestrator reads the verdict
- Full pipeline wiring: orchestrator runs planning → building → E2E in sequence
- Failure loop: if E2E fails, re-run planning agent with failure context from `memory.md`, then building agent with revised plan. Max 3 full loops.
- Terminal states:
  - Success: move Plane issue to "Human Review", post summary comment
  - Failure after 3 loops: move to "Failed", post comment with failure history
- **Plane description re-sync on retry:** every time the planning agent revises the plan (a retry triggered by E2E failure), the orchestrator rewrites the same fenced block introduced in Phase 3 with the new plan. Acceptance-criteria checkboxes already ticked stay ticked (we never un-check), since "this AC was demonstrably satisfied at some point" is still useful signal even if the plan rolled.
- Cleanup: remove worktrees, kill any lingering dev servers, clean `/workspaces/PLANE-{id}/`

**Acceptance test:**
- Create a real small issue (e.g., "add a tooltip to button X") in Plane
- Move to "In Progress"
- Full pipeline runs: plan → build → E2E → "Human Review"
- Vercel preview URL works and shows the change
- Plane issue has comments from each stage
- Per-issue memory files are complete on the branch
- Test failure path: create an issue that will fail E2E (e.g., deliberately vague acceptance criteria), verify:
  - Retry loop triggers (planning agent revises)
  - After 3 loops, moves to "Failed" with explanatory comment

---

### Phase 4.5: Comment-driven revise loop

Phase 4 closes the loop with E2E, but the reviewer (me) is still the last hop and has no way to *steer* the agent without hand-editing files. Add a feedback channel: I drop a comment on the Plane issue, the orchestrator notices, interrupts whatever Claude session is running, and re-enters the pipeline with the comment folded into `priorFailures`.

The same channel works in two situations:

1. **Mid-flight steering.** I see the agent going the wrong way while it is still in `planning` / `building` / `e2e_testing`. I comment, the active Claude session is killed cleanly, and the orchestrator restarts the planning stage with my note attached.
2. **Post-pipeline revise.** The pipeline already landed in `Human Review` (or `Failed`) and I want a change. I comment on the issue; the orchestrator re-opens the SQLite row, resets it to pre-planning, and runs the full plan→build→e2e loop again with my note attached.

**What to build:**

- **Comment polling.** Every poll cycle, list comments for every SQLite-tracked issue that is *not* terminal-Done (so: non-terminal pipeline states **and** `human_review` / `failed`). Filter to comments newer than `last_seen_comment_at` and not authored by the bot. The bot's own comments are tracked client-side: every `postComment` updates `last_seen_comment_at` to the just-created comment's `created_at`, so we never react to ourselves.
- **SQLite bookkeeping.**
  - `last_seen_comment_at TEXT` — high watermark, advanced by every bot post and by every consumed feedback comment.
  - `pending_feedback TEXT` — accumulator of unconsumed reviewer notes. Drained when the next planning loop starts.
- **Interrupt mechanism.** `ClaudeSession.abort()` triggers the same `/exit` → `SIGTERM` → `SIGKILL` shutdown sequence already used at end-of-session, and the run() promise resolves with a new `aborted: true` flag. The orchestrator wires the active session into a per-issue handle so the watcher can find it.
- **Re-entry.** When `pending_feedback` is set on a tracked issue:
  - If the issue is in a non-terminal pipeline state: the watcher aborts the current session. The pipeline catches the abort, reads `pending_feedback`, clears it, and re-enters the `plan` stage with the feedback prepended to `priorFailures`. Loop counter does **not** advance (it isn't an E2E failure — it's a steering correction).
  - If the issue is in `human_review` or `failed`: the watcher resets the row to `picked_up` (preserving branch/worktree/plan_path), clears `pending_feedback` into a `revisionFeedback` field on the next planner invocation, and the orchestrator picks the issue back up from `plan` stage on the next cycle. The Plane state is **not** auto-moved back to "In Progress" — the row's SQLite status drives the pipeline; the human can update Plane state independently.
- **Bot-author detection.** Comments authored by the API key user (us) are filtered out by `last_seen_comment_at` advancement (we always update the watermark right after a successful post). As a belt-and-braces fallback, the orchestrator records every comment id it has posted (in-memory + SQLite events) and the comment listing filters those out too.
- **Prompt extension.** The planning prompt grows a small "Reviewer feedback (from Plane comments since last loop)" block, populated only when feedback is present. The building / E2E prompts already carry priorFailures and need no shape change.

**Acceptance test:**

- Take an issue all the way to `Human Review`. Post a comment like "the button should be teal, not blue". Within `POLL_INTERVAL_MS` the orchestrator transitions the SQLite row back to a working state, the planner runs again with the comment visible in its prompt, and a fresh build+e2e cycle lands a new preview.
- While an issue is mid-build, post "no, refactor the whole thing into a hook instead". The current building session is killed, the next planning session sees the comment, and the resulting plan reflects the new direction (verify by reading `plan.md` diff).
- Post-revise comments are visible in SQLite events (`feedback_detected`, `session_aborted_for_feedback`, `feedback_consumed`).
- Bot comments never trigger another loop on themselves (`last_seen_comment_at` advances after every `postComment`).

**Not terminal-testable:**

- **Whether the reviewer's free-text feedback actually nudged the agent toward the desired outcome.** Same plan-quality gap as Phase 2 — the orchestrator can show the comment was ingested, but only a human reading the revised plan can confirm "yes, that's what I meant".

---

### Phase 5: Operational hardening

Round out the pipeline so infra hiccups don't masquerade as code failures, condense the per-issue memory into one file, and switch Vercel handling from "poll GitHub statuses" to "drive Vercel CLI directly" — the latter unblocks env-var injection (e.g. `CONVEX_DEPLOY_KEY` on preview) and gives us real build logs to feed back into the retry context.

This phase exists because Phase 4's first end-to-end run surfaced three real problems that would silently waste tokens or block forever in production:

1. The Plane API ignores the `state` query param and returns *all* issues — without a client-side filter, Backlog and Todo issues get treated as candidates.
2. The Plane API leaves `description_stripped` empty for issues created/updated via REST — the planning agent saw no description and wrote `Satisfies AC: none` for every phase. Already patched in code with an HTML-stripping fallback; the PRD-level lesson is that "the bot only sees what Plane bothers to give it" needs explicit instrumentation.
3. Vercel build failures (e.g. missing `CONVEX_DEPLOY_KEY` on preview env) currently terminal-fail the issue. Infra problems shouldn't burn a retry loop — the build code is fine, only the deploy keys are wrong.

**What to build:**
- **Vercel as a retriable resource, not a terminal one.** When a Vercel deployment fails for the head sha, the orchestrator does not move Plane to "Failed". Instead:
  - SQLite gains a `preview_retry_count` column (default 0).
  - On Vercel failure, increment the counter, post a "preview build failed (attempt N/MAX), retrying" Plane comment, leave the issue in `built` SQLite status, and re-enter the preview-wait stage on the next orchestrator cycle.
  - Hard cap: `MAX_PREVIEW_RETRIES` (default **3**, mirrors `MAX_PIPELINE_LOOPS`). Only after exhausting the cap do we transition to Failed with a clear `last_error="vercel preview failed N times, see logs"`.
  - Each failed Vercel attempt's build log is captured (see next item) and stitched into the planner's `priorFailures` block on the *next* pipeline loop — sometimes a "Vercel build failed" is really "code broke a thing only Next/Convex catches at build time" and the planner can use that.
- **Use the Vercel CLI for deploys + log retrieval.** Today the orchestrator pushes a branch and waits for GitHub-triggered Vercel auto-deploys. Switch to running `npx vercel deploy --token $VERCEL_TOKEN --target preview --yes` (or `vercel build && vercel deploy --prebuilt`) from the worktree:
  - Lets the orchestrator pass `--build-env CONVEX_DEPLOY_KEY=$KEY` directly, bypassing per-environment Vercel UI config.
  - Returns the preview URL synchronously, with no need to poll GitHub deployment statuses.
  - On failure, run `npx vercel inspect --logs <url>` and write the build log to `memory.md` so the next planning loop sees *why* it failed, not just *that* it failed.
  - GitHub-triggered auto-deploys can still run in parallel (they'll be redundant, just noise). Optionally configure summario's `vercel.json` `ignoreCommand` to skip auto-deploys on `agent/*` branches once orchestrator-driven deploys are reliable.
- **Per-issue memory consolidation: `memory.md`.** Today each issue has `progress.md`, `failures.md`, and `summary.md` — overlapping and confusing. Collapse to:
  - `plan.md` — planning agent output (unchanged).
  - `memory.md` — append-only narrative log across all sessions for this issue. One section per session (planning, each phase build, review pass, e2e loop) with status / notes / link-outs. Replaces both `progress.md` and `failures.md`.
  - `summary.md` — final human-facing reviewer notes at the end of a successful run (unchanged).
  - `done.flag` / verdict files — unchanged transient signals.
- **Exponential-repo self-commit workflow.** From this phase forward, each Phase 5/6/7 worth of work in *this* repo (the orchestrator codebase, not summario) ships as its own `feat(phase-N): …` commit pushed to `origin/main`, so the repo's history shows progress phase-by-phase instead of one-shot dumps at the end of a session.

**Acceptance test:**
- Trigger a build whose Vercel deploy is *guaranteed* to fail (e.g. point `CONVEX_DEPLOY_KEY` at an invalid value via `BUILDER_EXTRA_ENV`).
- Observe: the orchestrator retries 3× with the Vercel build log captured to `memory.md` each time, posts a comment per retry, and only on the third failure transitions Plane to Failed with `last_error` mentioning "vercel preview failed 3 times".
- Fix the env var, run a fresh issue, confirm the orchestrator now talks to Vercel CLI instead of polling `gh api`.
- Confirm `memory.md` is the only narrative file on the branch — no `progress.md`, no `failures.md`.
- Confirm this phase's commits appear in `origin/main` as separate `feat(phase-5): …` commits, not one mega-commit.

**Shipped in slice 5a-v2 (Vercel build-failure fixup loop — this commit):**

The original slice 5a treated a failed Vercel preview as a retriable resource and just re-polled the same SHA on a timer. That's nonsense — the same code can't build twice. A test run produced 800+ poll attempts and the matching count of Plane spam comments before the cap (intermittently undefined due to a config race) finally fired. **Slice 5a-v2 replaces this with an agent-driven fixup loop.**

- `preview_fixup_attempt_count` column + `MAX_PREVIEW_FIXUP_ATTEMPTS` cap (default 3, env-tunable). Renamed from the previous `preview_retry_count` / `MAX_PREVIEW_RETRIES`. The old `VERCEL_RETRY_PAUSE_MS` is removed — there's actual agent work between attempts, no sleep needed.
- On Vercel preview failure (`state !== "success"`), the orchestrator:
  1. Calls `npx vercel inspect --logs <preview-url>` and captures the tail (~50 KB) as the build log.
  2. Posts **one** Plane comment per fixup attempt (not per poll): `"Vercel preview build failed on <sha> (state: failure). Spawning fixup agent — attempt N/MAX."`.
  3. Spawns a fresh Claude session in the worktree with a dedicated `buildFixup` prompt (`src/prompts/buildFixup.ts`). The prompt embeds the build log, points the agent at `plan.md` + `memory.md` + recent commits, and instructs it to diagnose the root cause, fix the code, run `pnpm build` locally to confirm green, commit (`fix(PLANE-N): vercel build attempt M — <cause>`), and exit. No push, no Plane calls, no scope expansion. (Originally `progress.md`/`failures.md`; now `memory.md` after slice 5c.)
  4. After the session ends with verdict `fixup-ok`, the orchestrator commits any leftover `memory.md` notes, checks that HEAD actually advanced, and pushes the branch. Vercel auto-redeploys on the new SHA; the loop re-enters `waitForPreview` with the new SHA.
- Terminal failures:
  - Cap exhausted: `last_error = "vercel preview failed after N fixup attempt(s)"`.
  - Fixup verdict is `fixup-failed` or HEAD didn't advance: terminate immediately, since a fresh poll would just see the same failure on the same SHA.
  - No preview URL available (Vercel never registered a deployment): terminate — we have no log to give the agent, so there's no productive fixup to attempt.
- Reviewer-feedback abort (Phase 4.5) is honored throughout: the fixup session is spawned with an `AbortSignal` and a reviewer comment kills the in-flight session, drops back to the `plan` stage with the feedback folded in.
- The Vercel-CLI switch (full deploy via CLI, not just log retrieval) is still deferred — captured as slice 5b for a later turn. **Slice 5c (`memory.md` consolidation) and the per-phase-commit workflow shipped with Phase 6 below** (the multi-session builder needed both).

---

### Phase 6: Multi-session builder

Today one Claude session implements every phase of `plan.md` — long, expensive, and the context drifts the further you go. Switch to one fresh Claude session per plan phase, sharing state through `memory.md`.

**Why:**
- **Cheaper.** Per-session context starts fresh at the plan + memory, not at the entire transcript of previous phase work. On a 4-phase plan, this is roughly a 2-4× input-token reduction.
- **Sharper.** Each session has only the context it actually needs to implement *this phase*, not the agent's reasoning trail from earlier phases. Less context-clouding, fewer "the agent forgot the original constraint" failures.
- **Bounded.** Per-session timeouts (`PHASE_TIMEOUT_MS`, default 15 min) replace the current 30-min cap on the whole build run.

**What to build:**
- The Builder no longer spawns one Claude with the full plan. Instead it loops over `plan.md` phases and, for each:
  1. Build a per-phase prompt that contains: the full plan (for context), `memory.md` so far (what previous sessions did), and an explicit "implement Phase N and only Phase N" instruction.
  2. Spawn Claude in the worktree, wait for that phase's `done.flag`.
  3. Append the agent's outcome section to `memory.md` (status, attempts, satisfied AC, notes).
  4. Run `pnpm build` + commit the phase's changes from the orchestrator side (rather than trusting the agent to commit), so per-phase commits are uniform.
  5. If phase failed: append failure notes to `memory.md`, optionally retry the same phase in a fresh session (up to `PHASE_MAX_ATTEMPTS`, default 2), then either skip remaining phases or terminate the loop.
- The orchestrator-level pipeline loop (plan → build → review → e2e) is unchanged; only the build *stage* internals are rewritten.
- Each per-phase session is told: "Do not run dev server, do not push, do not call Plane — the orchestrator handles all of that. You implement, you run `pnpm build`, you write to `memory.md`, you exit."

**Acceptance test:**
- Pick up a 3-phase issue. Verify the orchestrator spawns exactly 3 Claude sessions (one per phase), each visible as separate `build_phase_session_started` / `build_phase_session_finished` event pairs in SQLite.
- `memory.md` on the branch has 3 phase-build sections, each authored by a distinct session, with prior sections visible to each later session at start time.
- Total Claude wall-clock time for the build stage is ≤ today's single-session time (best-case much less; worst-case equal if phases happen to need everything).
- A deliberately-failing Phase 2 surfaces as: Phase 1 session completes + commits + writes memory, Phase 2 session fails after retries + writes memory, Phase 3 session is *not* started (build stage terminates).

**Shipped:**

The build stage is now a per-phase loop in `Builder.build()`. For each `## Phase N` block (parsed by the new shared `src/plan.ts` `parsePlanPhases`, which extracts index + title + body + `Satisfies AC`):

1. A fresh Claude session (`src/prompts/buildPhase.ts`) gets the full plan, the running `memory.md`, and "implement Phase N and ONLY Phase N — no dev server, no commit, no push, no Plane calls; run `pnpm build`, write a report + `done.flag`, exit." Per-session cap is `PHASE_TIMEOUT_MS` (default 15 min).
2. The orchestrator runs the **authoritative** `pnpm build` itself (`src/pnpm.ts`) when the agent claims `phase-ok` — the agent's verdict alone isn't trusted.
3. The orchestrator (not the agent) writes the uniform `## Phase N` section to `memory.md` (`src/memory.ts` `formatPhaseSection`, parseable back by `parsePhaseOutcomes`) with a distinct per-session marker, then commits the phase as `feat(PLANE-N): phase M — <title>`.
4. A failed phase is retried in a fresh session up to `PHASE_MAX_ATTEMPTS` (default 2). If it still fails, the loop stops — later phases are not started — and the stage returns `ok:false`.

Events: `build_phase_session_started` / `build_phase_session_finished` (one pair per session, carrying `phase` + `attempt` + `verdict`), plus `build_phase_build_started/finished`, `build_phase_complete` / `build_phase_failed`. The Phase 4.5 reviewer-feedback abort is threaded through every per-phase session: an abort stops the loop and surfaces `aborted:true` so the pipeline re-plans. The dev server is gone from the build stage (per-phase browser checks are deferred to the E2E agent against the Vercel preview). Slice 5c (`memory.md`) folded in: `progress.md` + `failures.md` are replaced everywhere by the single append-only `memory.md`.

---

### Phase 6.5: Live dashboard fence

Today the Plane issue description (inside the `<!-- exponential:plan v1 ... -->` fence) carries the full plan rendered as HTML — useful for plan inspection, but noisy, and there is no in-issue indicator of where the pipeline currently is or which phases have shipped. Reviewers also routinely create issues with no `## Acceptance Criteria`, which leaves the AC-tick code path with nothing to tick and silently drops the build's verification surface. Replace the fence's contents with a compact live dashboard, and force every issue to carry ACs.

**What to build:**

- **AC enforcement (auto-draft, not hard-fail).** The Planning Agent always ensures the issue has an `## Acceptance Criteria` section:
  - If the human wrote one, leave it byte-for-byte alone.
  - If absent, the planner drafts 2–5 ACs from the description and injects them into the Plane description **above** the fence, wrapped in a sentinel like `<!-- exponential:ac-autodraft v1 start -->…<!-- exponential:ac-autodraft v1 end -->`. The orchestrator never re-stomps the contents on later loops — the human can edit freely, and the sentinel just records provenance.
  - Fallback: if the description is too thin to draft meaningful ACs (e.g. one-liner with no testable behavior), planning fails fast with a Plane comment ("description is too vague to extract acceptance criteria — please add a `## Acceptance Criteria` section or expand the description") and **does not** write a plan. The Plane state is left untouched (the issue is "left alone" for the human to expand), but the SQLite row is set to `failed` rather than `picked_up` — leaving it `picked_up` would make `hasActiveIssue()` treat it as the in-flight issue and permanently block the single-issue queue until someone hand-edited the DB. `failed` unblocks the queue; re-triggering still requires the human to clear the row (same as any other terminal issue, per the `!row` pickup guard).
- **Dashboard fence (replaces the plan dump).** Inside the existing `<!-- exponential:plan v1 ... -->` sentinels, render a compact status header + per-phase checklist instead of the full plan HTML:
  ```
  **Status:** Building — phase 2/3 · branch `agent/PLANE-42-add-button` · updated 14:02 UTC

  **Phases**
  - [x] Phase 1 — Add the button component (AC 1)
  - [ ] Phase 2 — Wire the handler (AC 2) ← active
  - [ ] Phase 3 — Telemetry (AC 3)

  Full plan: `.agent/issues/PLANE-42/plan.md` on branch `agent/PLANE-42-add-button`.
  ```
  Phase checkboxes flip on `build_phase_complete`. The full plan still lives at `plan.md` on the branch — the fence carries a link, not a dump.
- **Status header rewrites on every stage transition.** The orchestrator rewrites the `Status:` line + active-phase marker at each of: `planning_started`, `planning_complete`, `building_started`, every `build_phase_session_started` / `build_phase_complete`, `preview_wait_started`, `e2e_started`, terminal (`pipeline_human_review` / `pipeline_failed`). One Plane `updateDescriptionHtml` per transition — a handful per pipeline run, well under any rate limit.
- **Reuse the existing fence machinery.** `injectPlanFence` grows a dashboard mode (or splits into `injectDashboardFence`); the AC ticking code path (`tickAcceptanceCriteria`) is unchanged — it ticks the *human-facing* AC bullets above the fence, separate from the new per-phase TODO list inside the fence, which the orchestrator owns end-to-end.

**Acceptance test:**

- Create an issue with **no** `## Acceptance Criteria` section. Orchestrator picks it up; the description grows an auto-drafted AC section above the fence (with the sentinel comment); planning proceeds normally; phases tick the drafted ACs as they complete.
- Create a second issue with a one-line description and no ACs. Orchestrator picks it up, posts the "description too vague" comment, leaves the issue alone (no fence, no plan).
- During a normal pipeline run, the Plane description's fence shows a status line that transitions `Planning` → `Building — phase 1/N` → `Building — phase 2/N` → … → `E2E` → `Human Review`, and the phase checkboxes tick in real time as each `build_phase_complete` fires (visible via `curl <plane-issue> | grep Status`).
- The full plan does **not** appear inside the description fence (it lives at the linked path on the branch); the human-facing AC list above the fence is untouched after the first auto-draft, even across multiple pipeline loops.

**Not terminal-testable:**

- **Auto-drafted AC quality.** Whether the planner's drafted ACs match what the human would have written. The sentinel + the "human can edit, orchestrator never re-stomps" rule give the reviewer a recovery path, but the initial draft requires reading.

**Shipped:**

- **AC enforcement.** `buildPlanningPrompt` now takes `hasAcceptanceCriteria` + `acDraftRelPath`. When the issue has no `## Acceptance Criteria`, the agent either writes 2–5 drafted criteria to `ac-draft.md` (the planner injects them above the fence via `injectAutodraftedAc`, wrapped in the `<!-- exponential:ac-autodraft v1 … -->` sentinel) or — if the body is too thin — writes the `too-vague` verdict to `done.flag`. `Planner.plan` reads `detail.descriptionText` to decide `hasAcceptanceCriteria` (so once an auto-draft exists, retry loops detect it and never re-draft), throws `PlanningTooVagueError` on the `too-vague` verdict, and the orchestrator handles it by stripping any fence it created, posting the "too vague" comment, and marking the SQLite row `failed` (see the fallback note above — diverges from the original `picked_up` wording to avoid bricking the queue). The auto-drafted ACs render as a TipTap task list so the existing `tickAcceptanceCriteria` can tick them.
- **Dashboard fence.** New `src/dashboard.ts` renders the compact status header + per-phase ☑/☐/☒ checklist + plan link; `planeDescription.injectDashboardFence` (factored out of `injectPlanFence` via a shared `injectFence`) places it in the same sentinel fence. The **orchestrator owns the dashboard end-to-end**: a single `DashboardModel` for the in-flight issue, rewritten via `pushDashboard` on each transition — `Planning` (pre-plan), `Building — phase N/M` (driven by a new `onProgress` callback the builder fires per phase), `Review`, `E2E` (deploying/verifying), and the terminal `Human Review` / `Failed`. The planner and builder no longer dump the plan into the fence; the builder's `tickAcceptanceCriteria` path is unchanged and still ticks the human-facing AC bullets above the fence. The phase glyphs are plain text (not real checkboxes) on purpose, so the only tickable boxes are the AC list above the fence.

---

### Phase 7: Review pass

Insert a code-review hop between Build and E2E so we catch correctness/maintainability bugs the human reviewer would otherwise have to find. Output is a structured findings file; a *separate* fresh Claude session addresses the findings before E2E runs.

**Why this is its own session, not the builder's:**
- The builder's context is biased toward "I just wrote this" — it's bad at finding its own mistakes.
- A fresh reviewer session, with no implementation context, reads the diff cold and judges it against the plan and the original issue.
- The fixup session is *also* fresh — it reads only the review findings + the diff, with no attachment to the original implementation decisions.

**What to build:**
- After the Builder finishes successfully, the orchestrator spawns a **Review session**:
  - Prompt: "You are reviewing the diff at `agent/PLANE-{seq}-…` against `plan.md` and the original Plane issue. Use the `/review` skill / equivalent code-review checklist. Surface concrete bugs, regressions, type holes, and out-of-scope changes. Skip nits."
  - Output: `review.md` with a structured list of findings (severity, file:line, description, suggested fix).
  - On verdict `review-clean` (no actionable findings), skip the fixup session entirely and go straight to E2E.
- If `review.md` has findings, spawn a **Fixup session** in the same worktree:
  - Prompt: "Read `review.md`. Address each finding (or explicitly note why it isn't actionable). Run `pnpm build`. Append outcome to `memory.md`. Commit. Exit."
  - The fixup session has no other context from the build run.
- After fixup, the orchestrator re-runs the review session *once*. If still not clean, log the remaining findings and proceed to E2E anyway — the human reviewer will see them in `review.md` on the branch. (We don't want to block forever on subjective review feedback.)
- Pipeline order: plan → multi-session build (Phase 6) → review → fixup-if-needed → review-recheck → e2e → terminal state.

**Acceptance test:**
- Run a build that has an obvious code-smell (e.g. duplicated logic, unused import, swallowed error). Confirm:
  - Review session produces `review.md` with at least one finding.
  - Fixup session lands a new commit addressing the finding.
  - Review-recheck either says `review-clean` or surfaces *different* remaining findings (not the same ones — the fixup actually did something).
- Run a build with no real issues. Confirm `review.md` says `review-clean` and the pipeline goes straight to E2E.

**Shipped:**

The pipeline order is now `plan → build → review → fixup-if-needed → review-recheck → e2e`, with a dedicated `"review"` stage inserted between `build` and `e2e` in `Orchestrator.pipelineLoop`.

- New `src/reviewer.ts` (`Reviewer`) with `review()` and `fixup()`, plus prompts `src/prompts/review.ts` (reads the diff cold via `git diff origin/main...HEAD` against `plan.md` + the original issue, writes structured `### Finding N` entries to `review.md`, verdict `review-clean` | `review-findings`) and `src/prompts/reviewFixup.ts` (reads only `review.md`, addresses each finding, runs `pnpm build`, verdict `fixup-ok` | `fixup-failed`).
- `Orchestrator.runReviewStage`: runs the initial review; on `review-findings` spawns a fixup session then re-runs the review **once**; if findings remain it logs `review_proceeding_with_findings` and proceeds to E2E anyway (no blocking on subjective feedback). Every session is wrapped in `registerStageAbort`, so a reviewer-feedback comment aborts the review/fixup and drops back to the `plan` stage like every other stage.
- The stage is a **best-effort quality gate** — a thrown session is logged and treated as no-verdict, never failing the pipeline. `review.md` is committed + pushed each pass (so the human sees it on the branch); the fixup commit advances HEAD, and the orchestrator threads the post-fixup sha forward (`headShaForPreview`) so E2E's Vercel preview targets the reviewed/fixed commit. New config `review.timeoutMs` (`REVIEW_TIMEOUT_MS`, default 15 min); the fixup session reuses `CLAUDE_TIMEOUT_MS` since it builds. Events: `review_session_started/finished`, `review_pushed`, `review_clean`, `review_findings`, `review_fixup_started/finished/pushed`, `review_clean_after_fixup`, `review_proceeding_with_findings`.

---

### Phase 8: Deployment

Deploy the orchestrator to the server via Coolify.

**What to build:**
- Dockerfile: Node.js runtime, SQLite, git, pnpm (for summario worktrees), Claude Code CLI
- Coolify service config: container settings, restart policy, resource limits
- Volume mounts:
  - `/workspaces/` — git worktrees (persistent across restarts for in-flight issues)
  - Claude Code config dir — auth persistence
  - SSH key mount — for git operations
- Environment variables:
  - `PLANE_API_KEY`, `PLANE_BASE_URL`, `PLANE_PROJECT_ID`
  - `GITHUB_TOKEN`
  - `VERCEL_TOKEN`, `VERCEL_PROTECTION_BYPASS`
  - `SUMMARIO_REPO_URL` (git clone URL)
  - `POLL_INTERVAL_MS` (default 30000)
  - `MAX_RETRIES` (default 3)
- Health check: HTTP endpoint or process liveness check
- GitHub branch protection on summario `main`:
  - Require PR
  - Require status checks (typecheck, build)
  - Enable merge queue (squash merge)

**Acceptance test:**
- Orchestrator running on server via Coolify, visible in Coolify dashboard
- Container stays up (no crash loops)
- Create a Plane issue, move to "In Progress"
- Full pipeline runs on the server
- Issue arrives at "Human Review" with working Vercel preview
- Server resource usage stays within bounds (check `docker stats`)
- Orchestrator survives a restart (picks up where it left off or re-evaluates queue)

**Shipped:**

The deployable artifacts and the one piece of missing runtime surface (a health
endpoint) ship in this repo; the *acts* that need the live server + admin
credentials (the Coolify deploy itself, applying branch protection to summario)
are documented as runbooks in `README.md` for the operator to execute.

- **Health endpoint.** New `src/health.ts` serves `GET /healthz` (also `/`,
  `/health`) via `node:http` — 200 while the poll loop is alive or still
  booting, 503 once stale/stopped. `Orchestrator.getHealth()` reports the
  liveness snapshot (`status`, `startedAt`, `uptimeSeconds`, `lastCycleAt`,
  `lastCycleOk`, `inFlightIssueId`); "stale" trips when no poll cycle has
  finished within `max(3 × pollInterval, 90s)`. Wired into `index.ts` (started
  after `orchestrator.start()`, closed first on shutdown). New config
  `health.port` (`HEALTH_PORT`, default 8080, `0` disables) / `health.host`
  (`HEALTH_HOST`).
- **Dockerfile.** Rewritten multi-stage: a `base` carrying every binary the
  orchestrator shells out to (`claude` via `@anthropic-ai/claude-code`, `gh`
  from GitHub's apt repo, `git`/`openssh-client`/`sqlite3`, `pnpm@9`), a
  throwaway `toolchain`/`deps` path that compiles the native modules
  (`better-sqlite3`, `node-pty`) and runs `tsc`, and a slim `runtime` that
  copies only prod `node_modules` + `dist`. Fixes the prior bug where a global
  `NODE_ENV=production` made `pnpm install` skip `tsc` and break the build. Adds
  `HEALTHCHECK`, `EXPOSE 8080`, the three named-volume mountpoints, and
  container-path env defaults (`SUMMARIO_REPO_PATH=/summario`,
  `WORKTREE_BASE_PATH=/workspaces`, `CLAUDE_CONFIG_DIR=/app/claude-config`).
- **`docker-compose.yml`.** Coolify deployment unit: build, `restart:
  unless-stopped`, the five named/bind volumes (data, workspaces, claude-config,
  pre-installed summario clone, ro SSH dir), a compose-level health check, and
  `deploy.resources` limits (2 CPU / 4G).
- **Restart recovery** was already in place from earlier phases
  (`resumeOrphans` + `store.findResumableIssue`) — it resolves PRD open
  question #3 and the "survives a restart" acceptance criterion.
- **Docs.** `.env.example` gains `HEALTH_PORT`/`HEALTH_HOST` + a Phase 8 block
  (`GITHUB_TOKEN`, `VERCEL_TOKEN`, container/host path notes). `README.md` gets
  a Deployment section (health endpoint, volumes table + prerequisites, Coolify
  steps, branch-protection runbook) and a corrected phase status table.
- **Not done here (operator-side, needs live infra/admin):** the actual Coolify
  deploy, and running the `gh api … /branches/main/protection` call against
  summario. Both are spelled out in `README.md`.

> The image build was **not** verified in this environment (no Docker daemon
> available); the TypeScript build, the health-server behavior (200/503/404
> routing), and the config wiring were verified locally.

---

## Verification surface

Most acceptance criteria can be confirmed with **terminal commands + the Plane API + the orchestrator's structured logs**. `gh`, `git`, `curl`, `sqlite3`, `ls`, `cat`, `ps` cover the rest. The things that genuinely cannot be verified that way are listed per phase below.

### Phase 1 — Orchestrator Core

Everything is terminal-testable. Pickup order, the SQLite row, the pickup comment, the "skip when busy" branch, and graceful shutdown all surface in logs or `sqlite3 data/exponential.sqlite "…"`.

**Not terminal-testable:** _(none)_

### Phase 2 — Planning Agent

The pipeline is observable end-to-end: orchestrator logs → worktree on disk → `plan.md` file → git history → GitHub branch (via `gh api`) → Plane comment.

**Not terminal-testable:**
- **Plan quality.** Whether the phase decomposition is sane, the acceptance checks are meaningful, and the agent actually consulted `AGENTS.md` / `docs/` / `ctx7` rather than hallucinating. Requires human reading of `plan.md`.
- **Claude TUI scrollback.** Internal tool calls (`Bash`, `Read`, `Glob`, `Write`, `ctx7`) happen inside the pty and are not logged by us — only the bounded transcript is kept, and only on failure. To audit what the agent actually did, attach to the pty (not currently supported) or instrument the agent prompt to log its actions.

### Phase 3 — Building Agent

`pnpm typecheck` / `pnpm build` pass-fail, `git diff`, `git log`, dev-server port reachability via `curl`, branch push, Vercel deployment status via `gh api repos/.../commits/<sha>/check-runs` — all terminal.

**Not terminal-testable:**
- **Whether the building agent's per-phase browser checks actually verified the intent of the phase**, vs. were rubber-stamped. The agent reports success/failure, but the underlying browser interaction is inside the Claude TUI. Same instrumentation gap as Phase 2.
- **Code quality** (readability, maintainability, idiomatic fit). Requires human review of the diff.

### Phase 4 — E2E Agent + Full Pipeline

Verdict (pass/fail), retry-loop transitions, terminal-state writes (`Human Review` / `Failed`), and full Plane comment history are all in logs + SQLite + Plane.

**Not terminal-testable:**
- **Visual rendering of the Vercel preview.** `curl` can fetch the HTML and confirm a 200, but cannot confirm "the tooltip actually shows up" or "the layout isn't broken" — that's what the E2E agent does inside its own browser tool, and that browser instance is not surfaced back to us. A human or screen-recording would be needed to fully replay it.
- **Whether the E2E agent's verdict matches the user's intent**, beyond the structured acceptance checks. Same review gap as plan quality.

### Phase 4.5 — Comment-driven revise loop

Comment-listing API output, `last_seen_comment_at` advancement after every bot post, SQLite events for `feedback_detected` / `session_aborted_for_feedback` / `feedback_consumed`, and the resulting per-loop `priorFailures` block visible in agent prompts — all in SQLite + Plane + log lines.

**Not terminal-testable:**
- **Whether the agent actually followed the feedback.** The orchestrator can prove "your comment text was placed in the next planning prompt"; whether the revised plan reflects what you meant requires reading `plan.md` diffs.

### Phase 5 — Operational hardening

Vercel-retry transitions, `MAX_PREVIEW_RETRIES` cap, `memory.md` presence/absence, `vercel inspect --logs` output captured into `memory.md`, and the per-phase commit history of the *exponential* repo — all in SQLite + filesystem + `git log`.

**Not terminal-testable:**
- **Whether the captured Vercel build log is *useful* to the next planning loop.** The orchestrator can stitch it into `priorFailures`, but whether the planner actually understands "next/font fails because Convex schema diverged" requires looking at the revised plan. Same plan-quality gap as Phase 2.

### Phase 6 — Multi-session builder

Per-phase `build_phase_session_started`/`build_phase_session_finished` event counts in SQLite, `memory.md` section authorship (distinct per-session markers), per-phase commit timestamps, total wall-clock vs single-session baseline — all terminal.

**Not terminal-testable:**
- **Whether fresh sessions actually produce better-quality work** (the whole point of the split). Token cost is measurable from logs; quality requires reading the resulting diffs.

### Phase 6.5 — Live dashboard fence

Fence content after each stage transition (one `curl` + a small HTML matcher per transition), AC section presence + sentinel after the first plan, per-phase checkbox state vs `build_phase_complete` events, "description too vague" path leaving the SQLite row in `failed` with no `plan_path` and the Plane state untouched (no fence) — all terminal.

**Not terminal-testable:**
- **Auto-drafted AC quality.** Whether the drafted ACs actually capture the human's intent. Same plan-quality gap as Phase 2.

### Phase 7 — Review pass

Presence of `review.md` on the branch, fixup-session commit appearing between review and re-review, structured findings count per loop — all terminal.

**Not terminal-testable:**
- **Whether the reviewer's findings are correct.** A code-review agent can hallucinate problems; only a human reading the diff + `review.md` knows whether the findings are real.

### Phase 8 — Deployment

`docker ps`, `docker stats`, `docker inspect`, `gh api` for branch protection, Coolify's own HTTP API — all terminal.

**Not terminal-testable:**
- **Coolify dashboard ergonomics** (does the service look right in the UI). Functionally redundant — the API tells us the same thing — but the user-facing dashboard is the only way to confirm what an operator would see.

---

## Out of scope

- Telegram intake bot
- Video recording of browser sessions
- Concurrent agent execution
- Provider swapping (Codex, OpenCode, Gemini)
- Web dashboard (Plane is the dashboard)
- Multi-repo support
- Complex retry strategies beyond 3-loop max
- Orchestrator web UI or API

---

## Open questions

1. **Agent-browser headless on server** — confirm it runs headless without a display. May need `--headless` flag or Xvfb.
2. **Worktree + Convex dev** — does `pnpm dev` (which runs both Next.js and Convex) work from a git worktree? May need `npx convex dev --once` or point to the main Convex deployment.
3. **Recovery on restart** — if the orchestrator dies mid-planning, the SQLite row stays in `planning` and `hasActiveIssue` blocks new pickups indefinitely. Currently requires manual SQL fix. Decide a recovery policy (auto-fail rows older than X minutes? Re-run? Surface in logs?) before Phase 5.

## Resolved decisions

- **Rate limits:** `claude -p` is rate-limited on the Max plan, so Phase 2+ drives an **interactive** `claude` session via `node-pty`. Completion is signalled by the agent writing a `done.flag` file; the orchestrator then sends `/exit\r` (with SIGTERM/SIGKILL fallbacks).
- **Claude Code permissions:** automated sessions need `--permission-mode bypassPermissions` (or `dontAsk`); the default mode prompts in the TUI and will hang with no human to confirm.
- **Priority:** Plane priority field is configured and active. Queue sorts Urgent > High > Medium > Low > None.
- **Worktree path:** `<WORKTREE_BASE_PATH>/PLANE-<sequenceId>/` (default `./workspaces/`, overridable to `/workspaces/` in Docker). The same worktree is reused by Phase 3.
- **Summario clone:** for local dev, point `SUMMARIO_REPO_PATH` at the existing dev clone (or a symlink) so `.env` / `node_modules` come along free; for Phase 5, mount via Docker volume. No cloning-from-URL step needed for now.
- **Push timing:** the planning agent's branch is pushed at the end of Phase 2 (not deferred to Phase 3) so it appears on GitHub immediately for visibility.
- **Poll interval:** 30s default.
