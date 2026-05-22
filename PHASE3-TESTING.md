# Phase 3 — fastest way to test

Phase 3 wires the **Building Agent** into the orchestrator: it spins up a dev
server in the planning worktree, asks Claude to implement each phase from
`plan.md`, runs `pnpm build` per phase, commits + pushes the branch, syncs the
plan into the Plane issue description (inside a sentinel fence), and toggles
satisfied Acceptance-Criteria checkboxes.

The orchestrator now also **auto-resumes** any issue stuck in `planned` state
when it starts up.

---

## What was already verified for you

- `pnpm typecheck` ✅
- `pnpm build` ✅
- `pnpm smoke` (38 helper checks for fence injection, AC checkoff, progress
  parsing) ✅
- Orchestrator boots, polls, and respects the active-issue guard (8-second dry
  run, then SIGTERM — clean shutdown).

## What still needs a human / a live Claude session

- Whether the Building Agent's per-phase `pnpm build` actually succeeds on a
  real summario change.
- Whether `pnpm dev` cold-starts inside a worktree (open question #2 in the
  PRD — this is the first time it'll be exercised).
- The browser acceptance check that the agent runs against the dev server.
- Plane description sync against the real description-html format (the test
  harness exercises TipTap, bare-input, and markdown fallbacks, but Plane's
  exact serialization is only knowable by running it).

---

## Path A — fastest (≈ 5–15 min): resume the existing PLANE-11 plan

There is already a planned issue (`PLANE-11`, branch `agent/PLANE-11-test`,
plan committed and pushed). On startup the orchestrator will detect it and
jump straight to the Builder, skipping the planning round.

Caveat: the existing PLANE-11 plan was generated before the `Satisfies AC:`
prompt update, so **AC ticking will not be exercised on this path** — the
agent will write `Satisfies AC: none` and the description-sync will only inject
the plan fence (no checkboxes flipped). Everything else (Claude session, dev
server, per-phase build, commit, push, description fence, Plane comment) gets
tested.

```bash
# 1. (optional) sanity: confirm PLANE-11 is still in `planned`
sqlite3 data/exponential.sqlite \
  "SELECT sequence_id, status, branch_name, plan_path FROM issues;"

# 2. start the orchestrator and watch
pnpm dev
```

What to watch for in logs:

- `resuming planned issue into build` — auto-recovery kicked in.
- `dev server spawned, waiting for readiness` → `dev server ready` (or a
  warning + `continuing without it`).
- `spawning claude session`.
- `build pipeline finished`.

What to verify in the world:

- **GitHub** — `agent/PLANE-11-test` has new commits on top of the plan
  commit. `gh api repos/<owner>/summario/commits/<sha>/check-runs` to see
  Vercel preview status.
- **Plane** — new comment with build outcome; description now contains a
  `<!-- exponential:plan v1 start --> … <!-- exponential:plan v1 end -->`
  block.
- **SQLite** — `status` is now `built`, `head_sha` and `summary_path` are set.
  ```bash
  sqlite3 data/exponential.sqlite \
    "SELECT sequence_id, status, head_sha, summary_path, last_error FROM issues;"
  ```
- **Worktree** — `.agent/issues/<uuid>/progress.md` and `summary.md` exist.

---

## Path B — full pipeline from scratch (≈ 15–30 min)

Use this to exercise planning + building + AC ticking together.

```bash
# 1. clean slate
sqlite3 data/exponential.sqlite "DELETE FROM events; DELETE FROM issues;"
rm -rf workspaces/PLANE-*

# 2. (optional) delete the old remote branch so the next push is clean
cd ../summario && git push origin --delete agent/PLANE-11-test || true; cd -

# 3. create a Plane issue with a clear, narrow scope. Suggested template:
```

Issue title: `Add data-plane-issue attribute to the landing hero`

Issue description:

```markdown
## Goal
Add a `data-plane-issue="PLANE-<seq>"` attribute on the root element of the
landing-page hero so a reviewer can confirm a preview build shipped a
deliberate change without altering any visible copy or layout.

## Acceptance Criteria
- [ ] The landing hero's root element exposes `data-plane-issue` matching the
      issue's sequence id.
- [ ] No visible copy, styling, or layout change on the landing page.
- [ ] `pnpm build` is green; no new console errors on the preview.

## Browser Verification
Route: `/?preview=1`
Steps:
1. Open the landing page.
2. Inspect the hero root in DevTools.
Expected: a `data-plane-issue="PLANE-<seq>"` attribute is present and
nothing visible has changed compared to main.

## Notes / Constraints
Do not touch convex/, auth, or any integration code. Keep the change to a
single attribute on an existing landing-page component.
```

Move the issue to **In Progress**, then:

```bash
pnpm dev
```

The orchestrator picks it up within one poll cycle (3s with the current
`POLL_INTERVAL_MS=3000`), runs planning, then building. At the end:

- The Plane issue description should now have the `<!-- exponential:plan v1 -->`
  fence appended **below** your original AC list.
- At least one AC checkbox should be `[x]` (or the TipTap equivalent).
- The branch is pushed; the Plane comment links to the commit sha.

---

## Tear-down / iteration commands

```bash
# wipe everything to test again
sqlite3 data/exponential.sqlite "DELETE FROM events; DELETE FROM issues;"
rm -rf workspaces/PLANE-*

# remove a single issue's state without nuking everything
sqlite3 data/exponential.sqlite \
  "DELETE FROM events WHERE plane_work_item_id = '<uuid>';
   DELETE FROM issues WHERE plane_work_item_id = '<uuid>';"

# kill a stuck dev server (the orchestrator should clean it up, but if it dies hard)
lsof -ti:3001 -ti:3002 -ti:3003 | xargs -r kill -9

# inspect the last n events for an issue
sqlite3 data/exponential.sqlite \
  "SELECT created_at, event_type, substr(details,1,80)
   FROM events ORDER BY id DESC LIMIT 30;"
```

## Config knobs you may want to tweak

- `BUILDER_DEV_SERVER=off` — skip starting `pnpm dev` entirely (the agent
  falls back to build-only verification). Useful if Convex/turbopack startup
  in a worktree is flaky.
- `BUILDER_MAX_ATTEMPTS=1` — fail fast instead of retrying up to 3×.
- `CLAUDE_TIMEOUT_MS=600000` — shorter (10-min) cap on each Claude session if
  you want to bail faster on a hung run.
- `LOG_LEVEL=trace` — more detail per cycle. Already at `debug`.
