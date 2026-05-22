# Phase 4 — fastest way to test

Phase 4 wires the **E2E Verification Agent** and the **full retry loop** on top of Phase 3. The orchestrator now runs the complete pipeline:

```
pickup → plan → build → wait-vercel-preview → e2e → human_review | failed
                              ▲                       │
                              └── re-plan w/ failures ┘ (up to MAX_PIPELINE_LOOPS, default 3)
```

On success the issue is moved to **Human Review** in Plane (with a comment + preview URL). On failure after the loop cap, it's moved to **Failed**.

---

## What's new vs. Phase 3

- `src/e2e.ts` + `src/prompts/e2e.ts` — E2E verification agent (independently tests the preview against the original issue intent).
- `src/vercel.ts` — polls `gh api` for Vercel deployment status until the preview reaches a terminal state.
- `src/orchestrator.ts` — full pipeline state machine with retry loops, Plane state transitions (`Human Review` / `Failed`), and optional worktree cleanup.
- `src/planner.ts` — accepts `priorFailures` for revision loops, syncs the plan into the Plane description fence after each (re-)plan.
- `src/git.ts` — `addWorktree` now reuses an existing worktree on the same branch, so revision loops don't nuke the implementation.
- `src/store.ts` — `markE2eTesting` / `markHumanReview` / `markFailed` / `resetForLoop`, plus `loops` and `preview_url` columns. `built` is no longer terminal.
- `.env.example` — `PLANE_HUMAN_REVIEW_STATUS`, `PLANE_FAILED_STATUS`, `VERCEL_PROTECTION_BYPASS`, `VERCEL_READY_TIMEOUT_MS`, `E2E_TIMEOUT_MS`, `MOCK_TEST_USER_EMAIL`, `MOCK_TEST_USER_PASSWORD`, `MAX_PIPELINE_LOOPS`, `CLEAN_WORKTREE_ON_FINISH`, `SUMMARIO_GITHUB_REPO` (optional override).

---

## Pre-flight checklist (must be true before testing)

1. **Plane has a "Failed" state.** Currently your Plane only has Brainstorm/Backlog/Todo/In Progress/Human Review/Merging/Done/Cancelled. The orchestrator will fail fast on startup with:
   > `Plane state "Failed" not found in project … Available states: …`

   Either create a `Failed` state in the project, or override:
   ```bash
   echo 'PLANE_FAILED_STATUS=Cancelled' >> .env   # if you'd rather reuse Cancelled
   ```

2. **Vercel protection bypass header.** Without this the E2E agent's HTTP calls to the preview return Vercel's auth wall HTML. Get it from Vercel: Project → Settings → Deployment Protection → **Protection Bypass for Automation** → copy the token.
   ```bash
   echo 'VERCEL_PROTECTION_BYPASS=<your-bypass-token>' >> .env
   ```

3. **Mock test user (only required if the issue needs auth to verify).** Per the summario "agent readiness" PRD — create a low-blast-radius dedicated account in your Convex auth setup.
   ```bash
   echo 'MOCK_TEST_USER_EMAIL=agent-tester@summario.dev' >> .env
   echo 'MOCK_TEST_USER_PASSWORD=<password>' >> .env
   ```
   If you don't set these, the E2E agent writes `e2e-blocked` for any issue that requires sign-in. The pipeline then moves to `Failed` after the loop cap (not a retry, since blocked ≠ failed-but-fixable).

4. **`gh auth status`** must report logged in (already true in your env). The Vercel poller shells out to `gh api`.

---

## Fastest test path (uses PLANE-13 — already at `planned`)

PLANE-13 (rename meeting title) is still in the DB at `planned`, with the planning agent's branch + commit already pushed. On orchestrator startup, it will auto-resume into **build → wait-preview → e2e** without re-planning.

```bash
cd /Users/luiskisters/code/private/projects/exponential

# 1. ensure prereqs are set in .env (see checklist above)
# 2. confirm DB row + state:
sqlite3 data/exponential.sqlite \
  "SELECT sequence_id, status, branch_name, head_sha, loops, preview_url FROM issues;"

# 3. start
pnpm dev
```

What to watch for in logs (in order):

```
resuming orphaned issue                              resumeFrom: build
build stage finished                                  ok: true
preview_wait_started                                  (sha)
vercel preview reached terminal state                 state: success / failure
e2e_started
e2e stage finished                                    verdict: e2e-passed | e2e-failed | e2e-blocked
pipeline_human_review | pipeline_failed
```

Side terminal — live event tail:
```bash
watch -n 2 'sqlite3 data/exponential.sqlite \
  "SELECT created_at, event_type, substr(details,1,80) FROM events ORDER BY id DESC LIMIT 20;"'
```

What to verify in the world when it finishes:

- **Plane** — PLANE-13's state has moved to `Human Review` (success) or `Failed` (loops exhausted). New comments at each stage: pickup, planning, build, plus a final "Ready for Human Review" / "Pipeline failed" with the preview URL.
- **GitHub** — the branch has the plan commit + per-phase implementation commits. Vercel preview deployment reached terminal state (visible at `gh api repos/luisKisters/summario/commits/<sha>/check-runs`).
- **SQLite** — `status` is `human_review` or `failed`, `preview_url` is filled, `loops` reflects how many tries it took.

Expected wall-clock: **20–60 minutes** depending on how many loops it needs and Vercel build time.

---

## Path B — fresh issue, exercise the success path with AC ticking

Use this for a clean test of the full pipeline including AC checkoff on success.

```bash
# 1. clean slate
sqlite3 data/exponential.sqlite "DELETE FROM events; DELETE FROM issues;"
rm -rf workspaces/PLANE-*
cd ../summario && git push origin --delete agent/PLANE-13-rename-meeting-my-clicking-on-title-and-somehow || true; cd -

# 2. create a small, well-scoped Plane issue (suggested template below)
# 3. move it to In Progress
# 4. pnpm dev
```

Suggested issue (small enough to ship in a single loop, has ACs):

**Title:** `Add data-plane-issue attribute to landing hero`

**Description:**
```markdown
## Goal
Add a `data-plane-issue` attribute on the landing-page hero root so a reviewer can confirm a preview build shipped a deliberate change without altering any visible copy or layout.

## Acceptance Criteria
- [ ] The landing hero's root element exposes `data-plane-issue` matching the issue's PLANE-X identifier.
- [ ] No visible copy, styling, or layout change on the landing page.
- [ ] `pnpm build` is green; no new console errors on the preview.

## Browser Verification
Route: `/?preview=1`
1. Open the landing page.
2. Inspect the hero root.
Expected: `data-plane-issue="PLANE-X"` attribute is present.

## Notes / Constraints
No convex/, auth, or integration changes. Single attribute on an existing component.
```

---

## Path C — deliberately fail to exercise the retry loop

To watch the planning revision flow:

Create an issue with **deliberately vague** acceptance criteria that cannot be satisfied in one shot, e.g.:

```markdown
## Goal
Improve the meetings list.

## Acceptance Criteria
- [ ] The meetings list feels better.
- [ ] Users prefer the new version.
```

The E2E agent will keep marking `e2e-failed` (because "feels better" can't be observed). After `MAX_PIPELINE_LOOPS` (default 3) the orchestrator moves the issue to `Failed` with a comment listing each loop's failure. The Plane description fence will have been re-injected on each revision with the new plan.

To bail faster, drop `MAX_PIPELINE_LOOPS=1` in `.env`.

---

## Tear-down / iteration commands

```bash
# wipe everything to test again
sqlite3 data/exponential.sqlite "DELETE FROM events; DELETE FROM issues;"
rm -rf workspaces/PLANE-*

# remove a single issue's state
sqlite3 data/exponential.sqlite \
  "DELETE FROM events WHERE plane_work_item_id = '<uuid>';
   DELETE FROM issues WHERE plane_work_item_id = '<uuid>';"

# kill stuck dev servers
lsof -ti:3001 -ti:3002 -ti:3003 | xargs -r kill -9

# last 30 events for an issue
sqlite3 data/exponential.sqlite \
  "SELECT created_at, event_type, substr(details,1,120)
   FROM events
   WHERE plane_work_item_id = '<uuid>'
   ORDER BY id DESC LIMIT 30;"

# inspect the per-issue agent memory
ls workspaces/PLANE-<n>/.agent/issues/*/
cat workspaces/PLANE-<n>/.agent/issues/<uuid>/{plan,progress,failures,summary}.md 2>/dev/null
```

## Config knobs you may want to tweak

- `MAX_PIPELINE_LOOPS=1` — fail fast for the first end-to-end test.
- `VERCEL_READY_TIMEOUT_MS=300000` — 5-min cap on preview wait (default 10 min).
- `E2E_TIMEOUT_MS=600000` — 10-min cap on the E2E session (default 20 min).
- `CLEAN_WORKTREE_ON_FINISH=true` — auto-remove the worktree after a terminal outcome.
- `BUILDER_DEV_SERVER=off` — skip starting `pnpm dev` (open PRD question #2 on convex-in-worktree).

## What's still not verified

- Whether `pnpm dev` reliably starts inside a worktree (open PRD question #2). The Builder treats this as best-effort and falls back to build-only verification.
- Plane description's exact checkbox HTML in your live instance — my `tickAcceptanceCriteria` handles TipTap (`<li data-checked>`), bare HTML (`<input type="checkbox">`), and markdown (`- [ ]`), but only a live run confirms which format Plane actually serializes to.
- The mock test user / Convex auth flow — depends on the summario "agent readiness" PRD being done.
- The E2E agent's actual browser interactions are inside its Claude TUI and not surfaced back to the orchestrator (same instrumentation gap as Phase 2 and 3).
