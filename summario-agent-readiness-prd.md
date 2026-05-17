# Summario Agent Readiness — PRD

Prepare the summario repo so autonomous agents (Exponential) can work on it.

**Repo:** summario (this repo)
**Dependency:** none — can run in parallel with the Exponential orchestrator PRD

---

## Context

The Exponential system (separate PRD) is an autonomous agent pipeline that picks up Plane issues and implements them. Before it can work, summario needs two things:

1. A way for agents to use the app without Google OAuth
2. Documentation that gives agents enough context to implement features correctly

---

## Phases

Each phase is independently executable by an agent. Between phases, context can be cleared — PROGRESS.md carries forward what was done and what's next.

### Phase 1: Mock Test User

Add a dev-only auth bypass so agents can exercise the app without Google OAuth.

**What to build:**
- Convex environment variable `TESTING_MODE` (never set in production)
- When `TESTING_MODE=true`, the auth layer accepts a hardcoded test token and returns a seeded test user identity
- The test user can exercise all app functionality: create meetings, create/edit templates, trigger Drive flows
- Production guard: the bypass checks the deployment URL or uses a Convex-specific mechanism to ensure it cannot activate in production, even if someone sets the env var

**Implementation notes:**
- This touches Convex auth. Read `convex/_generated/ai/guidelines.md` before starting.
- The app currently uses Convex Auth with Google OAuth. The bypass should work at the Convex auth layer, not at the Next.js middleware level.
- The test user needs a stable identity (same user ID across sessions) so meetings/templates persist between agent runs.

**Acceptance test:**
- Set `TESTING_MODE=true` in Convex dev environment variables
- Start local dev (`pnpm dev`)
- Open the app in a browser — should land on the authenticated home page without any Google login
- Create a meeting using the test user, verify it appears in the meetings list
- Create a template, verify it persists
- Verify `TESTING_MODE` has no effect when the Convex deployment URL is a production URL

---

### Phase 2: Project Memory Files

Create the documentation agents need to understand the project and operate correctly.

**What to build:**

**`docs/architecture.md`** — App architecture, tech stack, folder structure. Cover:
- Next.js app router structure
- Convex backend (schema, functions, actions)
- Key data models (meetings, templates, series, drive integration)
- How the meeting lifecycle works (setup → bot joins → transcription → summary → approval → drive upload)
- Folder layout with short descriptions of what lives where

**`docs/conventions.md`** — Coding style and patterns. Cover:
- TypeScript conventions used in this project
- Convex patterns (queries, mutations, actions, validators)
- React/Next.js patterns (server components, client components, form handling)
- UI component conventions (shadcn/ui, Tailwind usage)
- Testing conventions

**`docs/runbook.md`** — How to operate the project. Cover:
- How to start the dev server (`pnpm dev` — what it runs)
- How to deploy (Vercel for frontend, Convex for backend)
- Environment variables and where they're set
- How to run typecheck, build, tests
- CLI tools available and their auth state
- Common gotchas

**`docs/product.md`** — Product context. Cover:
- What summario does (meeting transcription → structured summaries → Drive upload)
- Target users and use cases
- Current feature set
- Terminology (meeting, template, series, occurrence, etc.)

**`AGENTS.md` update** — Add operating rules for autonomous agents:
- Never push directly to main
- Always create a branch per issue
- Always run `pnpm typecheck` + `pnpm build` before browser tests
- If blocked, write exactly why to per-issue memory
- Use mock test user, never real auth
- Respect the phased plan — don't skip phases
- Don't change scope without noting it in memory

**`.agent/` directory** — Create the per-issue memory structure:
```
.agent/
  README.md           — explains the memory format and rules
  issues/             — empty dir, per-issue subdirs created by agents
```

README should document:
- File format: `plan.md`, `progress.md`, `failures.md`, `summary.md`
- Rules: append-only for progress.md, never overwrite, specific failure notes (expected vs actual)

**Acceptance test:**
- All files exist with accurate content
- Run a quick check: does `docs/architecture.md` match the actual folder structure?
- Does `docs/runbook.md` include correct commands that actually work?
- Does `AGENTS.md` include both the existing content (Convex guidelines, Context7) and the new agent rules?

---

## Out of scope

- GitHub branch protection setup (handled in the Exponential deployment phase)
- Vercel protection bypass secret (infrastructure, not repo code)
- Any changes to the app's actual features
