# Exponential

Autonomous agent orchestrator that turns Plane issues into shipped code.

This repository implements the full PRD pipeline — polling Plane, picking up
"In Progress" issues, then driving Claude Code through plan → multi-session
build → code review → E2E against a Vercel preview, with a comment-driven
revise loop and restart recovery throughout. Phase 8 packages it for
deployment to a server via Coolify.

See [`exponential-prd.md`](./exponential-prd.md) for the full plan.

## Status

| Phase | Status |
|---|---|
| 1. Orchestrator Core | ✅ |
| 2. Planning Agent | ✅ |
| 3. Building Agent | ✅ |
| 4. E2E Agent + Full Pipeline | ✅ |
| 4.5 Comment-driven revise loop | ✅ |
| 5. Operational hardening | ✅ |
| 6. Multi-session builder | ✅ |
| 6.5 Live dashboard fence | ✅ |
| 7. Review pass | ✅ |
| 8. Deployment (Docker / Coolify) | ✅ |

## Requirements

- Node.js 20+
- pnpm
- A reachable Plane instance and an API key with read/write access to the
  target project.
- The Claude Code CLI on `PATH` (or set `CLAUDE_BINARY`), authenticated against
  your account (`claude auth login`).
- A local clone of the target repo (summario) at `SUMMARIO_REPO_PATH` with
  write access on the configured remote.

## Setup

```bash
pnpm install
cp .env.example .env
# fill the Plane vars + SUMMARIO_REPO_PATH (point at your existing clone)
```

## Run

Development (watch + tsx):

```bash
pnpm dev
```

Build + run:

```bash
pnpm build
pnpm start
```

Both `pnpm start` and `pnpm dev` auto-load `.env` from the project root via
Node's `--env-file-if-exists` flag. To skip the file, run `node dist/index.js`
directly with the env injected another way (`direnv`, container env, etc.).

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PLANE_BASE_URL` | yes | — | Base URL of your Plane instance (no trailing slash). |
| `PLANE_API_KEY` | yes | — | Plane API key. Sent via `X-Api-Key`. |
| `PLANE_WORKSPACE_SLUG` | yes | — | Plane workspace slug. |
| `PLANE_PROJECT_ID` | yes | — | UUID of the target Plane project. |
| `PLANE_IN_PROGRESS_STATUS` | no | `In Progress` | State name the orchestrator polls. |
| `SUMMARIO_REPO_PATH` | yes | — | Absolute path to a local clone of the summario repo. |
| `WORKTREE_BASE_PATH` | no | `./workspaces` | Directory under which per-issue worktrees live. |
| `SUMMARIO_DEFAULT_BRANCH` | no | `main` | Branch that feature branches are based on. |
| `SUMMARIO_REMOTE_NAME` | no | `origin` | Remote name used for fetch + push. |
| `CLAUDE_BINARY` | no | `claude` | Path to the Claude Code CLI. |
| `CLAUDE_TIMEOUT_MS` | no | `1800000` | Hard cap per planning session (ms). |
| `CLAUDE_EXTRA_ARGS` | no | _(empty)_ | Extra args passed to every `claude` invocation. |
| `POLL_INTERVAL_MS` | no | `30000` | Poll interval. |
| `DATABASE_PATH` | no | `./data/exponential.sqlite` | SQLite file path. |
| `LOG_LEVEL` | no | `info` | `trace` / `debug` / `info` / `warn` / `error`. |
| `HEALTH_PORT` | no | `8080` | HTTP health endpoint port (`0` disables it). |
| `HEALTH_HOST` | no | `0.0.0.0` | Health endpoint bind address. |
| `GITHUB_TOKEN` | in Docker | — | Token for the `gh` CLI + git push. |
| `VERCEL_TOKEN` | in Docker | — | Vercel CLI token (no keyring in a container). |

This table covers the core + Phase 8 vars; see [`.env.example`](./.env.example)
for the complete, commented list (build/E2E/review timeouts, dev-server policy,
mock test user, comment-poll cadence, etc.).

## Phase 1 acceptance test

Performed manually against a real Plane instance.

1. Make sure `.env` is populated and the orchestrator builds: `pnpm build`.
2. Start the orchestrator: `pnpm start`. It should log:
   - `starting exponential`
   - `orchestrator started` with the resolved state id.
3. In Plane, create a test issue (any priority, e.g. `Medium`) and move it to
   **In Progress**. Within `POLL_INTERVAL_MS` (default 30 s, immediate first
   cycle on boot) the orchestrator should:
   - Log `picking up issue` with the issue's sequence id and priority.
   - Post a `Picked up by Exponential.` comment on the issue.
   - Insert a row into `data/exponential.sqlite` (`issues` table) with
     `status = 'picked_up'`.
4. While the first issue is still recorded as `picked_up`, create a **second**
   issue with a **higher** priority and move it to **In Progress**. The
   orchestrator should log `active issue in flight, skipping pickup` and
   **not** comment on the second issue. (Phase 1 picks one issue at a time;
   later phases will release the lock when work completes.)
5. Stop the orchestrator with `Ctrl+C`. It should log
   `received shutdown signal` → `orchestrator stopped` → `shutdown complete`
   and exit cleanly.

Inspect the SQLite store:

```bash
sqlite3 data/exponential.sqlite \
  "SELECT plane_work_item_id, sequence_id, priority, status, picked_up_at FROM issues;"
sqlite3 data/exponential.sqlite \
  "SELECT plane_work_item_id, event_type, details, created_at FROM events ORDER BY id;"
```

## Phase 2 acceptance test

Performed manually against a real Plane instance with `SUMMARIO_REPO_PATH`
pointing at a working summario clone.

1. Ensure `claude` is on `PATH` and authenticated (`claude auth login`).
2. Start the orchestrator: `pnpm dev` (verbose mode for live logs).
3. In Plane, create an issue with a goal, acceptance criteria, and a browser
   verification block. Move it to **In Progress**.
4. Within `POLL_INTERVAL_MS` the orchestrator should:
   - Log `picking up issue` and post the `Picked up by Exponential.` comment.
   - Log `preparing planning worktree` with a `branch` and `worktreePath`.
   - Spawn `claude` in the new worktree (`spawning claude session`).
5. Watch the worktree (`<WORKTREE_BASE_PATH>/PLANE-<seq>/`). The planning
   agent will read `AGENTS.md`/`CLAUDE.md`/`docs/`, then write
   `.agent/issues/<work-item-id>/plan.md` and finally
   `.agent/issues/<work-item-id>/done.flag`.
6. The orchestrator should then log `done flag observed, asking claude to
   exit` → `planning complete`, commit + push the branch, and post a
   `Planning complete.` comment to Plane listing the phases.
7. Confirm on GitHub that the `agent/PLANE-<seq>-<slug>` branch exists with
   a single commit containing the plan.

Re-running the same issue: the orchestrator considers `status='planned'`
non-terminal, so it will not re-pick the issue until you either (a) implement
Phase 3 to advance state or (b) manually update the row:
`sqlite3 data/exponential.sqlite "UPDATE issues SET status='human_review' WHERE sequence_id=<n>;"`.

## Architecture

```
src/
├── index.ts          entry point + signal handling
├── config.ts         env var parsing + validation
├── logger.ts         pino structured logger
├── plane.ts          Plane SDK wrapper (states + work items + comments)
├── store.ts          better-sqlite3 schema + issue/event accessors
├── orchestrator.ts   poll loop, priority queue, pickup, dispatch to planner
├── planner.ts        Phase 2 — orchestrates worktree → claude → plan → commit → push
├── git.ts            child_process wrapper for git worktree / commit / push
├── claude.ts         node-pty wrapper that runs interactive `claude` sessions
└── prompts/
    └── planning.ts   planning agent system/user prompt template
```

## Queue logic

On every poll the orchestrator:

1. Looks up the configured "In Progress" state ID once at startup
   (`PLANE_IN_PROGRESS_STATUS`).
2. Skips entirely if any tracked issue is in a non-terminal status
   (`picked_up`, `planning`, `building`, …). Phase 1 only writes `picked_up`,
   so the lock releases when the issue is manually moved to a terminal state
   in the DB.
3. Otherwise, fetches all work items currently in that state and filters out
   any that already have a non-terminal row in SQLite.
4. Sorts the survivors by `priority` (`urgent` > `high` > `medium` > `low` >
   `none`) and breaks ties by `updated_at` ascending (oldest first ≈ FIFO).
5. Records the winner with `status = 'picked_up'` and posts the pickup comment.

## Deployment (Phase 8)

The `Dockerfile` ships everything the orchestrator shells out to — the Claude
Code CLI, `git` + `openssh-client`, the GitHub CLI (`gh`), `pnpm`, and `npx`
(for `vercel`). Native deps (`better-sqlite3`, `node-pty`) are compiled in a
throwaway toolchain stage; the runtime image is slim and carries only the built
artifacts. `docker-compose.yml` is the Coolify deployment unit.

### Health endpoint

The process serves `GET /healthz` (default `:8080`) — `200` while the poll loop
is alive, `503` once it goes stale or stops. Both the Docker `HEALTHCHECK` and
the compose health check poll it; set `HEALTH_PORT=0` to disable.

```bash
curl -fsS localhost:8080/healthz | jq
# {"status":"ok","startedAt":"…","uptimeSeconds":42,"lastCycleAt":"…",
#  "lastCycleOk":true,"inFlightIssueId":null,"pollIntervalMs":30000}
```

### Volumes

| Mount | Purpose |
|---|---|
| `/app/data` | SQLite DB — in-flight issue state, survives restarts. |
| `/workspaces` | Git worktrees for in-flight issues (`WORKTREE_BASE_PATH`). |
| `/app/claude-config` | Claude Code auth/config (`CLAUDE_CONFIG_DIR`). |
| `/summario` | **Pre-installed** summario clone (`SUMMARIO_REPO_PATH`). |
| `/root/.ssh` (ro) | Deploy key + `known_hosts` for git push over SSH. |

Two prerequisites the volumes must satisfy before the first real run:

- **`/summario` must be pre-installed.** The builder symlinks
  `<summario>/.env` and `<summario>/node_modules` into each worktree, so
  `pnpm install` must already have run in the mounted clone.
- **`/app/claude-config` must hold a Claude login.** Authenticate once into the
  volume, e.g. `docker exec -it <container> claude` (or seed the volume from a
  workstation login). Automated sessions run with
  `--permission-mode bypassPermissions` (set via `CLAUDE_EXTRA_ARGS`).

### Coolify

1. New service → **Docker Compose**, pointed at this repo.
2. Set the secrets in the Coolify env UI: `PLANE_API_KEY`, `GITHUB_TOKEN`,
   `VERCEL_TOKEN`, `VERCEL_PROTECTION_BYPASS`, `MOCK_TEST_USER_PASSWORD` — plus
   the non-secret `PLANE_*`, `SUMMARIO_GITHUB_REPO`, `MOCK_TEST_USER_EMAIL`.
3. Attach the summario clone + SSH key volumes (see `SUMMARIO_HOST_PATH` /
   `SSH_DIR_HOST_PATH` in `.env.example`).
4. Deploy. Coolify's health check tracks `/healthz`; `restart: unless-stopped`
   handles crash recovery, and the orchestrator resumes any orphaned in-flight
   issue from SQLite on boot (`resuming orphaned issue`).

```bash
# local image smoke (Docker required):
docker build -t exponential .
docker compose up      # wires the volumes + healthcheck from docker-compose.yml
```

### GitHub branch protection (summario `main`)

Phase 8 also gates merges to summario behind PR + status checks + a merge
queue. Run against the **summario** repo (needs admin):

```bash
gh api -X PUT repos/<owner>/summario/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [
    { "context": "typecheck" }, { "context": "build" } ] },
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "enforce_admins": false,
  "restrictions": null
}
JSON
# Merge queue (squash) is enabled in the repo UI: Settings → General →
# "Allow merge queue", merge method "Squash".
```
