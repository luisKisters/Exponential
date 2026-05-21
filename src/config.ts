export interface Config {
  plane: {
    baseUrl: string;
    apiKey: string;
    workspaceSlug: string;
    projectId: string;
    inProgressStatus: string;
  };
  summario: {
    repoPath: string;
    worktreeBasePath: string;
    defaultBranch: string;
    remoteName: string;
  };
  claude: {
    binary: string;
    timeoutMs: number;
    extraArgs: string[];
  };
  pollIntervalMs: number;
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
  return {
    plane: {
      baseUrl: required("PLANE_BASE_URL").replace(/\/+$/, ""),
      apiKey: required("PLANE_API_KEY"),
      workspaceSlug: required("PLANE_WORKSPACE_SLUG"),
      projectId: required("PLANE_PROJECT_ID"),
      inProgressStatus: optional("PLANE_IN_PROGRESS_STATUS", "In Progress"),
    },
    summario: {
      repoPath: required("SUMMARIO_REPO_PATH"),
      worktreeBasePath: optional("WORKTREE_BASE_PATH", "./workspaces"),
      defaultBranch: optional("SUMMARIO_DEFAULT_BRANCH", "main"),
      remoteName: optional("SUMMARIO_REMOTE_NAME", "origin"),
    },
    claude: {
      binary: optional("CLAUDE_BINARY", "claude"),
      timeoutMs: int("CLAUDE_TIMEOUT_MS", 30 * 60_000),
      extraArgs: optional("CLAUDE_EXTRA_ARGS", "")
        .split(/\s+/)
        .filter((s) => s.length > 0),
    },
    pollIntervalMs: int("POLL_INTERVAL_MS", 30_000),
    databasePath: optional("DATABASE_PATH", "./data/exponential.sqlite"),
    logLevel: optional("LOG_LEVEL", "info"),
  };
}
