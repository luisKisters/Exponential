# Exponential

Autonomous agent orchestrator that turns Plane issues into shipped code.

This repository currently implements **Phase 1 (Orchestrator Core)** of the PRD —
polling Plane, picking up "In Progress" issues, posting a comment, and recording
state in SQLite.

See [`exponential-prd.md`](./exponential-prd.md) for the full plan.

## Status

| Phase | Status |
|---|---|
| 1. Orchestrator Core | ✅ |
| 2. Planning Agent | ⏳ |
| 3. Building Agent | ⏳ |
| 4. E2E Agent + Full Pipeline | ⏳ |
| 5. Deployment | ⏳ |

## Requirements

- Node.js 20+
- pnpm
- A reachable Plane instance and an API key with read/write access to the
  target project.

## Setup

```bash
pnpm install
cp .env.example .env
# fill PLANE_BASE_URL, PLANE_API_KEY, PLANE_WORKSPACE_SLUG, PLANE_PROJECT_ID
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

Environment variables are read directly from the process — load your `.env`
with whatever you use locally (e.g. `direnv` or `node --env-file=.env`).

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PLANE_BASE_URL` | yes | — | Base URL of your Plane instance (no trailing slash). |
| `PLANE_API_KEY` | yes | — | Plane API key. Sent via `X-Api-Key`. |
| `PLANE_WORKSPACE_SLUG` | yes | — | Plane workspace slug. |
| `PLANE_PROJECT_ID` | yes | — | UUID of the target Plane project. |
| `PLANE_IN_PROGRESS_STATUS` | no | `In Progress` | State name the orchestrator polls. |
| `POLL_INTERVAL_MS` | no | `30000` | Poll interval. |
| `DATABASE_PATH` | no | `./data/exponential.sqlite` | SQLite file path. |
| `LOG_LEVEL` | no | `info` | `trace` / `debug` / `info` / `warn` / `error`. |

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

## Architecture (Phase 1)

```
src/
├── index.ts          entry point + signal handling
├── config.ts         env var parsing + validation
├── logger.ts         pino structured logger
├── plane.ts          Plane SDK wrapper (states + work items + comments)
├── store.ts          better-sqlite3 schema + issue/event accessors
└── orchestrator.ts   poll loop, priority queue, pickup
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

## Docker

A `Dockerfile` is included for Phase 5; it builds the TypeScript and runs
`node dist/index.js`. The SQLite file lives at `/app/data/exponential.sqlite`
which is exposed as a volume.

```bash
docker build -t exponential .
docker run --rm \
  -e PLANE_BASE_URL=... \
  -e PLANE_API_KEY=... \
  -e PLANE_WORKSPACE_SLUG=... \
  -e PLANE_PROJECT_ID=... \
  -v $(pwd)/data:/app/data \
  exponential
```
