import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { linkRepoArtifacts } from "./builder.js";
import { ClaudeSession } from "./claude.js";
import type { Config } from "./config.js";
import { Git } from "./git.js";
import type { Logger } from "./logger.js";
import { ensureMemoryFile } from "./memory.js";
import type { PlaneIssueDetail } from "./plane.js";
import { buildReviewPrompt } from "./prompts/review.js";
import { buildReviewFixupPrompt } from "./prompts/reviewFixup.js";
import type { Store } from "./store.js";

export type ReviewVerdict = "review-clean" | "review-findings" | "no-verdict";

export interface ReviewInput {
  issue: PlaneIssueDetail;
  branch: string;
  worktreePath: string;
  planRelPath: string;
  loopNumber: number;
  pass: "initial" | "recheck";
  /** Optional abort signal for reviewer-feedback interruption. */
  signal?: AbortSignal;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  /** Number of `### Finding` entries parsed from review.md. */
  findingsCount: number;
  aborted: boolean;
  doneFlagSeen: boolean;
  timedOut: boolean;
  /** HEAD sha after committing/pushing review.md (null if nothing pushed). */
  headSha: string | null;
}

export interface ReviewFixupInput {
  issue: PlaneIssueDetail;
  branch: string;
  worktreePath: string;
  planRelPath: string;
  loopNumber: number;
  signal?: AbortSignal;
}

export interface ReviewFixupResult {
  verdict: string;
  aborted: boolean;
  doneFlagSeen: boolean;
  advancedHead: boolean;
  newHeadSha: string;
  pushedSha: string | null;
}

/** Aggregate result the orchestrator's review stage returns to the pipeline. */
export interface ReviewStageResult {
  aborted: boolean;
  /** Latest pushed sha after review/fixup, or null if unchanged. */
  headSha: string | null;
}

/**
 * Phase 7: code-review hop between Build and E2E. A fresh reviewer session
 * reads the diff cold and writes structured findings to review.md; a separate
 * fresh fixup session addresses them. The orchestrator drives the
 * review → fixup → recheck sequence (see Orchestrator.runReviewStage).
 */
export class Reviewer {
  private readonly git: Git;
  private readonly claude: ClaudeSession;

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.git = new Git(logger, config.summario.repoPath);
    this.claude = new ClaudeSession(logger);
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const { issue, branch, worktreePath, planRelPath, loopNumber, pass, signal } = input;
    const shortId = `PLANE-${issue.sequenceId}`;

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const reviewAbs = join(issueDir, "review.md");
    const doneFlagAbs = join(issueDir, "done.flag");

    // Fresh signals each pass; the agent rewrites review.md from scratch.
    for (const p of [doneFlagAbs, reviewAbs]) {
      if (existsSync(p)) await rm(p);
    }

    const prompt = buildReviewPrompt({
      workItemId: issue.id,
      shortId,
      sequenceId: issue.sequenceId,
      title: issue.name,
      descriptionText: issue.descriptionText,
      branch,
      // The worktree was branched from origin/<default>; there's usually no
      // local <default> ref, so the diff must be taken against the remote one.
      baseBranch: `${this.config.summario.remoteName}/${this.config.summario.defaultBranch}`,
      planRelPath,
      reviewRelPath: relative(worktreePath, reviewAbs),
      doneFlagRelPath: relative(worktreePath, doneFlagAbs),
      loopNumber,
      pass,
    });

    this.store.recordEvent(issue.id, "review_session_started", {
      pass,
      loop: loopNumber,
      promptLength: prompt.length,
    });

    const result = await this.claude.run({
      cwd: worktreePath,
      prompt,
      doneFlagPath: doneFlagAbs,
      timeoutMs: this.config.review.timeoutMs,
      inactivityNudgeMs: this.config.claude.inactivityNudgeMs,
      inactivityTimeoutMs: this.config.claude.inactivityTimeoutMs,
      binary: this.config.claude.binary,
      extraArgs: this.config.claude.extraArgs,
      usePrintMode: this.config.claude.usePrintMode,
      signal,
    });

    const flagRaw = (await safeRead(doneFlagAbs)) ?? "";
    const verdict = parseReviewVerdict(flagRaw);
    const reviewMd = (await safeRead(reviewAbs)) ?? "";
    const findingsCount = countFindings(reviewMd);

    this.store.recordEvent(issue.id, "review_session_finished", {
      pass,
      loop: loopNumber,
      exitCode: result.exitCode,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
      inactivityTimedOut: result.inactivityTimedOut,
      inactivityNudged: result.inactivityNudged,
      aborted: result.aborted,
      verdict,
      findingsCount,
    });

    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

    if (result.aborted) {
      return {
        verdict,
        findingsCount,
        aborted: true,
        doneFlagSeen: result.doneFlagSeen,
        timedOut: result.timedOut,
        headSha: null,
      };
    }

    // Commit review.md to the branch so the human reviewer sees it, then push
    // (review.md is a new/changed file on every pass).
    let headSha: string | null = null;
    try {
      const committed = await this.git.commitAll(
        worktreePath,
        `chore(review): ${shortId} review (loop ${loopNumber}, ${pass}) — ${verdict}`,
      );
      if (committed) {
        await this.git.push(worktreePath, this.config.summario.remoteName, branch);
        headSha = await this.git.headSha(worktreePath);
        this.store.recordEvent(issue.id, "review_pushed", {
          pass,
          headSha,
        });
      }
    } catch (err) {
      this.logger.warn(
        { err, workItemId: issue.id, pass },
        "failed to commit/push review.md (continuing)",
      );
    }

    return {
      verdict,
      findingsCount,
      aborted: false,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
      headSha,
    };
  }

  async fixup(input: ReviewFixupInput): Promise<ReviewFixupResult> {
    const { issue, branch, worktreePath, planRelPath, loopNumber, signal } = input;
    const shortId = `PLANE-${issue.sequenceId}`;

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const reviewAbs = join(issueDir, "review.md");
    const memoryAbs = join(issueDir, "memory.md");
    const doneFlagAbs = join(issueDir, "done.flag");

    await linkRepoArtifacts(this.logger, {
      sourceRepo: this.config.summario.repoPath,
      worktreePath,
    });
    await ensureMemoryFile(memoryAbs, shortId);
    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

    const preSha = await this.git.headSha(worktreePath);

    const prompt = buildReviewFixupPrompt({
      workItemId: issue.id,
      shortId,
      sequenceId: issue.sequenceId,
      title: issue.name,
      descriptionText: issue.descriptionText,
      branch,
      planRelPath,
      reviewRelPath: relative(worktreePath, reviewAbs),
      memoryRelPath: relative(worktreePath, memoryAbs),
      doneFlagRelPath: relative(worktreePath, doneFlagAbs),
      loopNumber,
    });

    this.store.recordEvent(issue.id, "review_fixup_started", {
      loop: loopNumber,
      preSha,
      promptLength: prompt.length,
    });

    const result = await this.claude.run({
      cwd: worktreePath,
      prompt,
      doneFlagPath: doneFlagAbs,
      timeoutMs: this.config.claude.timeoutMs,
      inactivityNudgeMs: this.config.claude.inactivityNudgeMs,
      inactivityTimeoutMs: this.config.claude.inactivityTimeoutMs,
      binary: this.config.claude.binary,
      extraArgs: this.config.claude.extraArgs,
      usePrintMode: this.config.claude.usePrintMode,
      signal,
    });

    const verdict = ((await safeRead(doneFlagAbs)) ?? "").trim().split(/\s+/)[0] ?? "";
    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

    this.store.recordEvent(issue.id, "review_fixup_finished", {
      loop: loopNumber,
      exitCode: result.exitCode,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
      inactivityTimedOut: result.inactivityTimedOut,
      inactivityNudged: result.inactivityNudged,
      aborted: result.aborted,
      verdict,
    });

    if (result.aborted) {
      return {
        verdict: "aborted",
        aborted: true,
        doneFlagSeen: result.doneFlagSeen,
        advancedHead: false,
        newHeadSha: preSha,
        pushedSha: null,
      };
    }

    // Commit whatever the agent changed (code + its memory.md note).
    await this.git.commitAll(
      worktreePath,
      `fix(${shortId}): address review findings (loop ${loopNumber})`,
    );
    const newHeadSha = await this.git.headSha(worktreePath);
    const advancedHead = newHeadSha !== preSha;

    let pushedSha: string | null = null;
    if (advancedHead) {
      try {
        await this.git.push(worktreePath, this.config.summario.remoteName, branch);
        pushedSha = newHeadSha;
        this.store.recordEvent(issue.id, "review_fixup_pushed", {
          loop: loopNumber,
          headSha: newHeadSha,
        });
      } catch (err) {
        this.logger.error({ err, branch }, "git push (after review fixup) failed");
        this.store.recordEvent(issue.id, "review_fixup_push_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      verdict,
      aborted: false,
      doneFlagSeen: result.doneFlagSeen,
      advancedHead,
      newHeadSha,
      pushedSha,
    };
  }
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export function parseReviewVerdict(raw: string): ReviewVerdict {
  const t = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (t === "review-clean") return "review-clean";
  if (t === "review-findings") return "review-findings";
  return "no-verdict";
}

/** Count `### Finding` headings in review.md. */
export function countFindings(reviewMd: string): number {
  const matches = reviewMd.match(/^###\s+Finding\b/gim);
  return matches ? matches.length : 0;
}
