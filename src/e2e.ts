import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ClaudeSession } from "./claude.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
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
}

export interface E2eResult {
  verdict: E2eVerdict | "no-verdict";
  /** True if the agent wrote done.flag at all. */
  doneFlagSeen: boolean;
  /** True if the orchestrator killed the session for the timeout. */
  timedOut: boolean;
  /** Path (repo-rel) to the verdict file. */
  verdictRelPath: string;
  /** Path (repo-rel) to the failures notes (may not exist). */
  failuresRelPath: string;
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
    const { issue, branch, worktreePath, previewUrl, loopNumber, priorFailures } = input;

    this.store.markE2eTesting(issue.id, { previewUrl, loop: loopNumber });
    this.store.recordEvent(issue.id, "e2e_started", {
      branch,
      previewUrl,
      loop: loopNumber,
    });

    const issueDir = join(worktreePath, ".agent", "issues", issue.id);
    await mkdir(issueDir, { recursive: true });

    const progressAbs = join(issueDir, "progress.md");
    const failuresAbs = join(issueDir, "failures.md");
    const verdictAbs = join(issueDir, "verdict.txt");
    const doneFlagAbs = join(issueDir, "done.flag");

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
      progressRelPath: relative(worktreePath, progressAbs),
      failuresRelPath: relative(worktreePath, failuresAbs),
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
      binary: this.config.claude.binary,
      extraArgs: this.config.claude.extraArgs,
    });

    this.store.recordEvent(issue.id, "e2e_session_finished", {
      exitCode: result.exitCode,
      signal: result.signal,
      doneFlagSeen: result.doneFlagSeen,
      timedOut: result.timedOut,
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
      failuresRelPath: relative(worktreePath, failuresAbs),
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
