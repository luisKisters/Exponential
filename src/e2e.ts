import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ClaudeSession } from "./claude.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { ensureMemoryFile } from "./memory.js";
import type { PlaneIssueDetail } from "./plane.js";
import { buildE2ePrompt } from "./prompts/e2e.js";
import type { Store } from "./store.js";

export type E2eVerdict = "e2e-passed" | "e2e-failed" | "e2e-blocked";

export interface E2eInput {
  issue: PlaneIssueDetail;
  branch: string;
  worktreePath: string;
  previewUrl: string;
  loopNumber: number;
  priorFailures: string;
  /** Optional abort signal for reviewer-feedback interruption. */
  signal?: AbortSignal;
}

export interface E2eResult {
  verdict: E2eVerdict | "no-verdict";
  /** True if the agent wrote done.flag at all. */
  doneFlagSeen: boolean;
  /** True if the orchestrator killed the session for the timeout. */
  timedOut: boolean;
  /** Path (repo-rel) to the verdict file. */
  verdictRelPath: string;
  /** Path (repo-rel) to the per-issue memory log. */
  memoryRelPath: string;
  /** True if the session was interrupted by reviewer feedback. */
  aborted: boolean;
}

export class E2eRunner {
  private readonly claude: ClaudeSession;

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.claude = new ClaudeSession(logger);
  }

  async verify(input: E2eInput): Promise<E2eResult> {
    const { issue, branch, worktreePath, previewUrl, loopNumber, priorFailures, signal } = input;

    this.store.markE2eTesting(issue.id, { previewUrl, loop: loopNumber });
    this.store.recordEvent(issue.id, "e2e_started", {
      branch,
      previewUrl,
      loop: loopNumber,
    });

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const memoryAbs = join(issueDir, "memory.md");
    const verdictAbs = join(issueDir, "verdict.txt");
    const doneFlagAbs = join(issueDir, "done.flag");

    await ensureMemoryFile(memoryAbs, `PLANE-${issue.sequenceId}`);

    // Clear stale signals from previous loops.
    for (const p of [doneFlagAbs, verdictAbs]) {
      if (existsSync(p)) await rm(p);
    }

    const prompt = buildE2ePrompt({
      workItemId: issue.id,
      shortId: `PLANE-${issue.sequenceId}`,
      sequenceId: issue.sequenceId,
      title: issue.name,
      descriptionText: issue.descriptionText,
      branch,
      previewUrl,
      vercelBypass: this.config.vercel.protectionBypass,
      mockUser: this.config.mockUser,
      memoryRelPath: relative(worktreePath, memoryAbs),
      doneFlagRelPath: relative(worktreePath, doneFlagAbs),
      verdictRelPath: relative(worktreePath, verdictAbs),
      loopNumber,
      priorFailures,
    });

    this.store.recordEvent(issue.id, "e2e_session_started", {
      promptLength: prompt.length,
      loop: loopNumber,
    });

    const result = await this.claude.run({
      cwd: worktreePath,
      prompt,
      doneFlagPath: doneFlagAbs,
      timeoutMs: this.config.e2e.timeoutMs,
      inactivityNudgeMs: this.config.claude.inactivityNudgeMs,
      inactivityTimeoutMs: this.config.claude.inactivityTimeoutMs,
      binary: this.config.claude.binary,
      extraArgs: this.config.claude.extraArgs,
      usePrintMode: this.config.claude.usePrintMode,
      signal,
    });

    this.store.recordEvent(issue.id, "e2e_session_finished", {
      exitCode: result.exitCode,
      signal: result.signal,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
      inactivityTimedOut: result.inactivityTimedOut,
      inactivityNudged: result.inactivityNudged,
      aborted: result.aborted,
      loop: loopNumber,
    });

    // Prefer verdict.txt — done.flag has the same content but verdict.txt
    // semantically owns the answer.
    const verdictRaw = (await safeRead(verdictAbs)) ?? (await safeRead(doneFlagAbs)) ?? "";
    const verdict = parseVerdict(verdictRaw);

    if (existsSync(doneFlagAbs)) await rm(doneFlagAbs);

    return {
      verdict,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
      verdictRelPath: relative(worktreePath, verdictAbs),
      memoryRelPath: relative(worktreePath, memoryAbs),
      aborted: result.aborted,
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

export function parseVerdict(raw: string): E2eVerdict | "no-verdict" {
  const t = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (t === "e2e-passed") return "e2e-passed";
  if (t === "e2e-failed") return "e2e-failed";
  if (t === "e2e-blocked") return "e2e-blocked";
  return "no-verdict";
}
