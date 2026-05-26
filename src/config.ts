export interface Config {
  plane: {
    baseUrl: string;
    apiKey: string;
    workspaceSlug: string;
    projectId: string;
    inProgressStatus: string;
    humanReviewStatus: string;
    failedStatus: string;
  };
  summario: {
    repoPath: string;
    worktreeBasePath: string;
    defaultBranch: string;
    remoteName: string;
    /** Optional override; otherwise derived from `git remote get-url origin`. */
    githubRepo: string | null;
  };
  claude: {
    binary: string;
    timeoutMs: number;
    extraArgs: string[];
  };
  builder: {
    /** "auto" tries to start a dev server, "off" disables it, "required" fails the build if it can't come up. */
    devServer: "auto" | "off" | "required";
    /** First port to probe for the dev server. */
    devServerBasePort: number;
    /** Legacy single-session retry cap (Phase 3). Phase 6 builds per-phase; see phaseMaxAttempts. */
    maxAttempts: number;
    /** Phase 6: max attempts (fresh sessions) per plan phase before the build stage gives up. */
    phaseMaxAttempts: number;
    /** Phase 6: hard wall-clock cap on each per-phase Claude session. */
    phaseTimeoutMs: number;
    /** Phase 6: hard cap on the orchestrator-side `pnpm build` gate per phase. */
    buildTimeoutMs: number;
  };
  vercel: {
    /** Value of x-vercel-protection-bypass header (passed to E2E agent). */
    protectionBypass: string | null;
    /** Max time to wait for a preview deployment to reach a terminal state. */
    readyTimeoutMs: number;
    /** Phase 5 (slice 5a-v2): cap on fixup-session attempts after a failed Vercel build. */
    maxPreviewFixupAttempts: number;
  };
  e2e: {
    /** Hard timeout per E2E Claude session. */
    timeoutMs: number;
  };
  pipeline: {
    /** Max number of full plan→build→e2e loops before giving up. */
    maxLoops: number;
    /** If true, remove the worktree after a terminal outcome (success or failure). */
    cleanWorktreeOnFinish: boolean;
  };
  /** Optional mock test user the E2E agent signs in with. */
  mockUser: { email: string; password: string } | null;
  pollIntervalMs: number;
  /** Phase 4.5: how often to poll Plane comments for reviewer feedback. */
  commentPollIntervalMs: number;
  databasePath: string;
  logLevel: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function parseDevServerMode(raw: string): "auto" | "off" | "required" {
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "auto" || v === "required") return v;
  throw new Error(`Invalid BUILDER_DEV_SERVER value: ${raw}`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const mockEmail = optional("MOCK_TEST_USER_EMAIL", "");
  const mockPw = optional("MOCK_TEST_USER_PASSWORD", "");
  const mockUser = mockEmail && mockPw ? { email: mockEmail, password: mockPw } : null;
  const githubRepo = optional("SUMMARIO_GITHUB_REPO", "");

  return {
    plane: {
      baseUrl: required("PLANE_BASE_URL").replace(/\/+$/, ""),
      apiKey: required("PLANE_API_KEY"),
      workspaceSlug: required("PLANE_WORKSPACE_SLUG"),
      projectId: required("PLANE_PROJECT_ID"),
      inProgressStatus: optional("PLANE_IN_PROGRESS_STATUS", "In Progress"),
      humanReviewStatus: optional("PLANE_HUMAN_REVIEW_STATUS", "Human Review"),
      failedStatus: optional("PLANE_FAILED_STATUS", "Failed"),
    },
    summario: {
      repoPath: required("SUMMARIO_REPO_PATH"),
      worktreeBasePath: optional("WORKTREE_BASE_PATH", "./workspaces"),
      defaultBranch: optional("SUMMARIO_DEFAULT_BRANCH", "main"),
      remoteName: optional("SUMMARIO_REMOTE_NAME", "origin"),
      githubRepo: githubRepo.length > 0 ? githubRepo : null,
    },
    claude: {
      binary: optional("CLAUDE_BINARY", "claude"),
      timeoutMs: int("CLAUDE_TIMEOUT_MS", 30 * 60_000),
      extraArgs: optional("CLAUDE_EXTRA_ARGS", "")
        .split(/\s+/)
        .filter((s) => s.length > 0),
    },
    builder: {
      devServer: parseDevServerMode(optional("BUILDER_DEV_SERVER", "auto")),
      devServerBasePort: int("BUILDER_DEV_SERVER_PORT", 3001),
      maxAttempts: int("BUILDER_MAX_ATTEMPTS", 3),
      phaseMaxAttempts: int("PHASE_MAX_ATTEMPTS", 2),
      phaseTimeoutMs: int("PHASE_TIMEOUT_MS", 15 * 60_000),
      buildTimeoutMs: int("PNPM_BUILD_TIMEOUT_MS", 10 * 60_000),
    },
    vercel: {
      protectionBypass: optional("VERCEL_PROTECTION_BYPASS", "") || null,
      readyTimeoutMs: int("VERCEL_READY_TIMEOUT_MS", 10 * 60_000),
      maxPreviewFixupAttempts: int("MAX_PREVIEW_FIXUP_ATTEMPTS", 3),
    },
    e2e: {
      timeoutMs: int("E2E_TIMEOUT_MS", 20 * 60_000),
    },
    pipeline: {
      maxLoops: int("MAX_PIPELINE_LOOPS", 3),
      cleanWorktreeOnFinish:
        optional("CLEAN_WORKTREE_ON_FINISH", "false").toLowerCase() === "true",
    },
    mockUser,
    pollIntervalMs: int("POLL_INTERVAL_MS", 30_000),
    commentPollIntervalMs: int("COMMENT_POLL_INTERVAL_MS", 10_000),
    databasePath: optional("DATABASE_PATH", "./data/exponential.sqlite"),
    logLevel: optional("LOG_LEVEL", "info"),
  };
}
