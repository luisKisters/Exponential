import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

export interface PreviewResult {
  url: string;
  /** GitHub deployment id, useful for diagnostics. */
  deploymentId: number;
  /** Final status state from GitHub (success | failure | error | inactive). */
  state: string;
  /** True if the polling timed out without seeing a terminal state. */
  timedOut: boolean;
}

export interface WaitForPreviewOptions {
  /** owner/repo, e.g. "luisKisters/summario". */
  ghRepo: string;
  /** Commit sha to look up deployments for. */
  sha: string;
  /** Total max wait time (ms). Default 8 min. */
  timeoutMs?: number;
  /** Poll cadence (ms). Default 10 s. */
  pollIntervalMs?: number;
}

/**
 * Wait for a Vercel preview deployment for `sha` to reach a terminal state.
 *
 * Uses the `gh` CLI for auth — we expect the operator (or the deployment
 * image) to have `gh auth login` already done. Internally we hit the GitHub
 * REST API: list deployments for the sha, take the most recent, then poll its
 * statuses until one of {success, failure, error, inactive} appears.
 *
 * Resolves with the preview URL (`environment_url` from the latest status,
 * falling back to `target_url`). If no deployment shows up at all within the
 * timeout, throws — the caller treats that as "no preview, can't run E2E".
 */
export async function waitForPreview(
  logger: Logger,
  options: WaitForPreviewOptions,
): Promise<PreviewResult> {
  const {
    ghRepo,
    sha,
    timeoutMs = 8 * 60_000,
    pollIntervalMs = 10_000,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let lastDeployment: GhDeployment | null = null;

  while (Date.now() < deadline) {
    const deployments = await listDeployments(ghRepo, sha);
    if (deployments.length > 0) {
      // Most recent first.
      deployments.sort((a, b) => b.created_at.localeCompare(a.created_at));
      lastDeployment = deployments[0]!;

      const statuses = await listDeploymentStatuses(ghRepo, lastDeployment.id);
      const latest = statuses[0]; // GitHub returns newest first.
      if (latest) {
        const terminal = ["success", "failure", "error", "inactive"];
        if (terminal.includes(latest.state)) {
          const url = latest.environment_url ?? latest.target_url ?? "";
          logger.info(
            { sha, deploymentId: lastDeployment.id, state: latest.state, url },
            "vercel preview reached terminal state",
          );
          return {
            url,
            deploymentId: lastDeployment.id,
            state: latest.state,
            timedOut: false,
          };
        }
        logger.debug(
          { sha, deploymentId: lastDeployment.id, state: latest.state },
          "vercel preview not yet terminal, polling",
        );
      } else {
        logger.debug({ sha, deploymentId: lastDeployment.id }, "deployment has no status yet");
      }
    } else {
      logger.debug({ sha }, "no vercel deployment registered yet for sha");
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Timeout. If we at least saw a deployment, return what we have with timedOut=true
  // so the caller can decide whether to proceed (e.g. a long-running build that
  // never finished is different from "no deployment at all").
  if (lastDeployment) {
    const statuses = await listDeploymentStatuses(ghRepo, lastDeployment.id);
    const latest = statuses[0];
    return {
      url: latest?.environment_url ?? latest?.target_url ?? "",
      deploymentId: lastDeployment.id,
      state: latest?.state ?? "pending",
      timedOut: true,
    };
  }
  throw new Error(
    `no vercel deployment registered for ${ghRepo}@${sha.slice(0, 12)} within ${timeoutMs}ms`,
  );
}

interface GhDeployment {
  id: number;
  environment: string;
  created_at: string;
}
interface GhDeploymentStatus {
  state: string;
  environment_url?: string;
  target_url?: string;
  created_at: string;
}

async function listDeployments(repo: string, sha: string): Promise<GhDeployment[]> {
  const raw = await ghApi(`repos/${repo}/deployments?sha=${sha}`);
  if (!Array.isArray(raw)) return [];
  return raw as GhDeployment[];
}

async function listDeploymentStatuses(
  repo: string,
  deploymentId: number,
): Promise<GhDeploymentStatus[]> {
  const raw = await ghApi(`repos/${repo}/deployments/${deploymentId}/statuses`);
  if (!Array.isArray(raw)) return [];
  return raw as GhDeploymentStatus[];
}

/**
 * Invoke `gh api <path>` and parse the JSON. We shell out to gh rather than
 * implementing token-based GitHub auth ourselves so the local dev story stays
 * simple — gh's keyring auth is enough for Phase 4. Phase 5 (Docker) will need
 * GITHUB_TOKEN, which `gh auth login --with-token` can also consume.
 */
function ghApi(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", path], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`gh api ${path} failed (exit ${code}): ${stderr.trim()}`),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(
          new Error(
            `failed to parse gh api response for ${path}: ${(err as Error).message}`,
          ),
        );
      }
    });
  });
}

/**
 * Pull build logs for a failed Vercel preview via `npx vercel inspect --logs`.
 * The CLI uses local keyring auth (no token needed for the dev story); for
 * Phase 8 / Docker we'll set VERCEL_TOKEN and pass `--token $VERCEL_TOKEN`.
 *
 * Returns a trimmed tail (`maxBytes`, default 50 KB) of stdout+stderr — enough
 * for an agent to diagnose root cause without blowing the prompt budget.
 */
export function fetchBuildLogs(
  previewUrl: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? 50 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const args = ["-y", "vercel@latest", "inspect", "--logs", previewUrl];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.env["VERCEL_TOKEN"]) {
      args.push("--token", process.env["VERCEL_TOKEN"]);
    }
    const child = spawn("npx", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    const append = (chunk: Buffer | string): void => {
      out += chunk.toString();
      if (out.length > maxBytes * 2) {
        out = out.slice(out.length - maxBytes);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(killer);
      const trimmed = out.length > maxBytes ? out.slice(out.length - maxBytes) : out;
      // We don't care about exit code — even on a failed deployment, the CLI
      // exits 0 and the log content is what we want.
      resolve(trimmed);
    });
  });
}

/**
 * Derive "owner/repo" from a git remote URL. Supports both SSH and HTTPS.
 * Used as a fallback when SUMMARIO_GITHUB_REPO is not explicitly set.
 */
export function deriveGhRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  // SSH: git@github.com:owner/repo
  const ssh = /^git@github\.com:(.+)$/.exec(trimmed);
  if (ssh) return ssh[1]!;
  // HTTPS: https://github.com/owner/repo
  const https = /^https?:\/\/github\.com\/(.+)$/.exec(trimmed);
  if (https) return https[1]!;
  return null;
}
