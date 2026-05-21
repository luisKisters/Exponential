import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Logger } from "./logger.js";

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly cwd: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Build a branch name from a Plane sequence id and issue title.
 * Result: agent/PLANE-{seq}-{short-kebab}
 */
export function buildBranchName(sequenceId: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const base = slug.length > 0 ? slug : "issue";
  return `agent/PLANE-${sequenceId}-${base}`;
}

/**
 * Compute the worktree path for a given Plane sequence id.
 */
export function buildWorktreePath(
  worktreeBasePath: string,
  sequenceId: number,
): string {
  return resolve(worktreeBasePath, `PLANE-${sequenceId}`);
}

export class Git {
  constructor(
    private readonly logger: Logger,
    private readonly repoPath: string,
  ) {}

  /**
   * Verify the configured repo path is a git repository.
   */
  async ensureRepo(): Promise<void> {
    if (!existsSync(this.repoPath)) {
      throw new Error(`Summario repo path does not exist: ${this.repoPath}`);
    }
    await this.run(this.repoPath, ["rev-parse", "--git-dir"]);
  }

  /**
   * Fetch from the configured remote.
   */
  async fetch(remote: string): Promise<void> {
    this.logger.debug({ remote }, "git fetch");
    await this.run(this.repoPath, ["fetch", remote, "--prune"]);
  }

  /**
   * True if the branch already exists locally.
   */
  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.run(this.repoPath, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a worktree at `path` checked out on a new branch `branch` based on
   * `remote/baseBranch`. If the worktree already exists at that path, it is
   * removed first. If the branch already exists locally, we reuse it.
   */
  async addWorktree(
    path: string,
    branch: string,
    baseBranch: string,
    remote: string,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });

    // Remove any pre-existing worktree at this path.
    if (existsSync(path)) {
      this.logger.warn(
        { path },
        "worktree path already exists, removing before recreate",
      );
      try {
        await this.run(this.repoPath, [
          "worktree",
          "remove",
          "--force",
          path,
        ]);
      } catch (err) {
        // Worktree might not be registered; fall back to manual cleanup.
        this.logger.warn(
          { err, path },
          "git worktree remove failed, pruning + removing manually",
        );
      }
      await this.run(this.repoPath, ["worktree", "prune"]);
    }

    const baseRef = `${remote}/${baseBranch}`;
    const branchAlreadyExists = await this.branchExists(branch);

    const args = branchAlreadyExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, baseRef];

    this.logger.debug({ args, path, branch }, "git worktree add");
    await this.run(this.repoPath, args);
  }

  /**
   * Remove the worktree at `path` and prune.
   */
  async removeWorktree(path: string): Promise<void> {
    if (!existsSync(path)) return;
    try {
      await this.run(this.repoPath, ["worktree", "remove", "--force", path]);
    } catch (err) {
      this.logger.warn(
        { err, path },
        "git worktree remove failed; continuing",
      );
    }
    await this.run(this.repoPath, ["worktree", "prune"]);
  }

  /**
   * Stage everything and commit inside the given worktree. Returns true when a
   * commit was created; false if there was nothing to commit.
   */
  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    await this.run(worktreePath, ["add", "-A"]);
    const status = await this.run(worktreePath, [
      "status",
      "--porcelain",
    ]);
    if (status.stdout.trim() === "") {
      return false;
    }
    await this.run(worktreePath, ["commit", "-m", message]);
    return true;
  }

  /**
   * Push a branch from the worktree.
   */
  async push(
    worktreePath: string,
    remote: string,
    branch: string,
  ): Promise<void> {
    this.logger.debug({ remote, branch }, "git push");
    await this.run(worktreePath, ["push", "-u", remote, branch]);
  }

  /**
   * Get the current HEAD sha inside a worktree.
   */
  async headSha(worktreePath: string): Promise<string> {
    const res = await this.run(worktreePath, ["rev-parse", "HEAD"]);
    return res.stdout.trim();
  }

  private run(cwd: string, args: string[]): Promise<GitResult> {
    return new Promise<GitResult>((resolveRun, rejectRun) => {
      const child = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => rejectRun(err));
      child.on("close", (code) => {
        if (code === 0) {
          resolveRun({ stdout, stderr });
        } else {
          rejectRun(
            new GitError(
              `git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`,
              args,
              cwd,
              code,
              stderr,
            ),
          );
        }
      });
    });
  }
}
