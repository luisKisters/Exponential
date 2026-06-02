import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

/**
 * Thin GitHub helpers built on the `gh` CLI (already on PATH in dev + the Docker
 * image, authed via keyring or `GITHUB_TOKEN`). We shell out rather than
 * implement REST auth ourselves, matching `vercel.ts`'s `gh api` usage.
 *
 * Two concerns live here:
 *   1. `ensurePullRequest` — idempotently open (or find) the PR for a pushed
 *      branch and return its URL. Best-effort: a `gh` failure never sinks the
 *      pipeline, it just yields `null` and a warn log.
 *   2. `buildBlobUrl` / `buildPrBody` — pure URL + body builders, unit-tested
 *      via the smoke harness.
 */

export interface EnsurePrOptions {
  /** owner/repo, e.g. "luiskisters/summario". */
  ghRepo: string;
  /** Head branch (already pushed to the remote). */
  branch: string;
  /** Base branch the PR merges into. */
  baseBranch: string;
  title: string;
  /** Markdown PR body. */
  body: string;
}

/**
 * Ensure an open PR exists for `branch` and return its URL. If one already
 * exists we return it untouched (never opens a duplicate, never edits the
 * body). Returns `null` on any failure — the caller treats a missing PR link
 * as non-fatal.
 */
export async function ensurePullRequest(
  logger: Logger,
  opts: EnsurePrOptions,
): Promise<string | null> {
  const existing = await findPrUrl(opts.ghRepo, opts.branch);
  if (existing) {
    logger.debug(
      { branch: opts.branch, url: existing },
      "pull request already open for branch",
    );
    return existing;
  }

  try {
    const out = await gh([
      "pr",
      "create",
      "--repo",
      opts.ghRepo,
      "--base",
      opts.baseBranch,
      "--head",
      opts.branch,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ]);
    // `gh pr create` prints the PR URL on stdout.
    const url = firstUrl(out);
    if (url) {
      logger.info({ branch: opts.branch, url }, "opened pull request");
      return url;
    }
    // Couldn't parse a URL from stdout — fall back to a lookup.
    return await findPrUrl(opts.ghRepo, opts.branch);
  } catch (err) {
    // Most commonly a race where the PR already exists (`gh` exits non-zero).
    const fallback = await findPrUrl(opts.ghRepo, opts.branch);
    if (fallback) return fallback;
    logger.warn(
      { err, branch: opts.branch, ghRepo: opts.ghRepo },
      "failed to open pull request (continuing without PR link)",
    );
    return null;
  }
}

/** Look up the URL of the open PR whose head is `branch`, or null. */
async function findPrUrl(ghRepo: string, branch: string): Promise<string | null> {
  try {
    const out = await gh([
      "pr",
      "list",
      "--repo",
      ghRepo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url // empty",
    ]);
    const url = out.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Build a github.com blob URL for a repo-relative path on a branch. Branch and
 * path segments are URL-encoded per segment so slashes survive (GitHub resolves
 * `blob/<branch-with-slashes>/<path>` greedily).
 */
export function buildBlobUrl(
  ghRepo: string,
  branch: string,
  repoRelPath: string,
): string {
  const repo = ghRepo.replace(/^\/+|\/+$/g, "");
  const branchPath = encodeRefPath(branch);
  const filePath = encodeRefPath(repoRelPath);
  return `https://github.com/${repo}/blob/${branchPath}/${filePath}`;
}

function encodeRefPath(value: string): string {
  return value
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Render the Markdown body for an auto-opened PR. Links the Plane issue + the
 * full plan and lists the phases as an unchecked task list so the PR page shows
 * the same phase breakdown as the Plane dashboard.
 */
export function buildPrBody(input: {
  shortId: string;
  issueTitle: string;
  planUrl: string | null;
  phaseTitles: string[];
  planeIssueUrl?: string | null;
}): string {
  const lines: string[] = [];
  const issueLabel = `${input.shortId} — ${input.issueTitle}`;
  lines.push(
    input.planeIssueUrl
      ? `**Plane issue:** [${issueLabel}](${input.planeIssueUrl})`
      : `**Plane issue:** ${issueLabel}`,
  );
  if (input.planUrl) {
    lines.push(`**Plan:** [full plan on this branch](${input.planUrl})`);
  }
  lines.push("");
  lines.push("### Phases");
  if (input.phaseTitles.length === 0) {
    lines.push("_No phases parsed from the plan._");
  } else {
    input.phaseTitles.forEach((title, i) => {
      lines.push(`- [ ] Phase ${i + 1} — ${title}`);
    });
  }
  lines.push("");
  lines.push(
    "_Opened automatically by [Exponential](https://github.com/luiskisters/exponential). The Plane issue carries the live status, acceptance criteria, and preview link._",
  );
  return lines.join("\n");
}

/** Invoke `gh <args>` and resolve stdout, rejecting on a non-zero exit. */
function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(`gh ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`),
        );
      }
    });
  });
}

/** Extract the first https URL from a `gh` stdout blob. */
function firstUrl(text: string): string | null {
  const m = /https?:\/\/\S+/.exec(text.trim());
  return m ? m[0] : null;
}
