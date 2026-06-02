# syntax=docker/dockerfile:1
#
# Phase 8 image. The orchestrator shells out to several binaries at runtime, so
# they all have to be on PATH inside the container:
#   - claude  (Claude Code CLI)        — drives every agent session (node-pty)
#   - git     + openssh-client         — worktrees + push over SSH
#   - gh      (GitHub CLI)             — Vercel check-run lookups (`gh api`)
#   - pnpm                             — `pnpm build` inside summario worktrees
#   - npx                             — `npx -y vercel@latest inspect --logs`
# Native deps (better-sqlite3, node-pty) are compiled in a throwaway toolchain
# stage and only the built artifacts are copied into the slim runtime image.

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/usr/local/bin"

# Runtime OS deps + the GitHub CLI (from its own apt repo) + global npm CLIs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg git openssh-client sqlite3 \
  && install -m 0755 -d /usr/share/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g pnpm@9 "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

WORKDIR /app

# --- toolchain: only needed to compile native modules, never shipped ---
FROM base AS toolchain
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Full install (incl. devDeps) — needed for `tsc` in the build stage.
FROM toolchain AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Production-only install — what actually ships in the runtime image.
FROM toolchain AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# --- runtime: slim base, no compiler, only built artifacts ---
FROM base AS runtime
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/exponential.sqlite \
    WORKTREE_BASE_PATH=/workspaces \
    CLAUDE_CONFIG_DIR=/app/claude-config \
    SUMMARIO_REPO_PATH=/summario \
    HEALTH_HOST=0.0.0.0 \
    HEALTH_PORT=8080

# Persisted across restarts (see docker-compose.yml):
#   /app/data          — SQLite DB (in-flight issue state)
#   /workspaces        — git worktrees for in-flight issues
#   /app/claude-config — Claude Code auth/config (CLAUDE_CONFIG_DIR)
# The summario clone (/summario) and the SSH key (/root/.ssh) are bind/secret
# mounts supplied by the operator, not declared here.
RUN mkdir -p /app/data /workspaces /app/claude-config
VOLUME ["/app/data", "/workspaces", "/app/claude-config"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
