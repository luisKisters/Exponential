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
  progress.md   — running log (append-only)
  failures.md   — detailed failure notes
  summary.md    — final summary after completion
```

---

## Merge strategy

GitHub merge queue, no merge agent. Branch protection on summario's `main`:
- Require PR
- Require status checks (typecheck, build)
- Enable merge queue (squash merge)

---

## Phases

Each phase is independently executable by an agent. Between phases, context can be cleared — PROGRESS.md carries forward what was done and what's next.

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

### Phase 2: Planning Agent

Wire the planning agent into the orchestrator.

**What to build:**
- Planning agent system prompt template: instructs Claude Code to read the issue, read project memory files, use Context7 for library docs, and output a phased plan
- Orchestrator integration: spawn Claude Code CLI (`claude --dangerously-skip-permissions -p "<prompt>"` or equivalent non-interactive mode), capture stdout
- Clone/checkout summario repo if not already present, create feature branch `agent/PLANE-{id}-{short-title}`
- Write the plan to `.agent/issues/PLANE-{id}/plan.md` on the branch
- Commit the plan file
- Post plan summary as a Plane comment (abbreviated — just phase titles and one-line descriptions)
- Mark planning as complete in SQLite state

**Acceptance test:**
- Create an issue with goal + acceptance criteria + browser verification
- Move to "In Progress"
- Orchestrator picks it up, spawns planning agent
- Feature branch exists with `plan.md` containing multiple phases
- Each phase has: title, what to implement, browser acceptance check in natural language
- Plane comment shows the plan summary

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

**Acceptance test:**
- Given an issue with a completed plan (from Phase 2), trigger the building agent
- Worktree created, dev server starts on a non-conflicting port
- Code is implemented on the feature branch
- `pnpm typecheck` passes
- `pnpm build` passes
- Branch is pushed to GitHub
- Vercel preview deployment starts (visible in GitHub commit statuses)
- Plane comment shows what was built
- Worktree and dev server cleaned up

---

### Phase 4: E2E Agent + Full Pipeline

Wire the E2E agent and connect the full pipeline with failure loops.

**What to build:**
- E2E agent system prompt template: instructs Claude Code to read the original issue + memory, then independently test the Vercel preview
- Vercel preview URL detection: poll Vercel API or GitHub deployment statuses until the preview is ready (with timeout)
- `x-vercel-protection-bypass` header: pass to the E2E agent prompt so it configures agent-browser with the header
- Pass/fail logic: E2E agent writes verdict to `.agent/issues/PLANE-{id}/progress.md`; orchestrator reads it
- Full pipeline wiring: orchestrator runs planning → building → E2E in sequence
- Failure loop: if E2E fails, re-run planning agent with failure context from `failures.md`, then building agent with revised plan. Max 3 full loops.
- Terminal states:
  - Success: move Plane issue to "Human Review", post summary comment
  - Failure after 3 loops: move to "Failed", post comment with failure history
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

### Phase 5: Deployment

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
2. **Claude Code CLI non-interactive flags** — exact invocation for non-interactive mode with full tool access. Likely `claude -p "prompt" --dangerously-skip-permissions` but need to verify.
3. **Worktree + Convex dev** — does `pnpm dev` (which runs both Next.js and Convex) work from a git worktree? May need `npx convex dev --once` or point to the main Convex deployment.

## Resolved decisions

- **Rate limits:** use exponential backoff when Claude Code hits limits. No pre-sizing needed.
- **Priority:** Plane priority field is configured and active. Queue sorts Urgent > High > Medium > Low > None.
- **Worktree path:** `/workspaces/PLANE-{id}/` confirmed.
- **Poll interval:** 30s default.
