import { existsSync } from "node:fs";
import * as pty from "node-pty";
import type { Logger } from "./logger.js";

export interface ClaudeSessionOptions {
  /** Working directory the claude CLI is spawned in. */
  cwd: string;
  /** The full prompt text passed to claude as its positional argument. */
  prompt: string;
  /** Absolute path the orchestrator polls for to detect "agent finished". */
  doneFlagPath: string;
  /** Hard wall-clock cap on the session, in milliseconds. */
  timeoutMs: number;
  /** Path to the claude binary. Default "claude". */
  binary?: string;
  /** Extra args appended after the binary. */
  extraArgs?: string[];
  /** Extra env merged into process.env when spawning. */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional abort signal. When it fires (orchestrator received reviewer
   * feedback and wants to interrupt), we run the same /exit → SIGTERM → SIGKILL
   * shutdown sequence as a normal completion and resolve with `aborted: true`.
   */
  signal?: AbortSignal | undefined;
}

export interface ClaudeSessionResult {
  exitCode: number | null;
  signal: number | null;
  /** Captured stdout/stderr (mostly TUI escape sequences, but useful on failure). */
  transcript: string;
  /** True if the done.flag file was observed before exit/timeout. */
  doneFlagSeen: boolean;
  /** True if the session was force-killed because of the timeout. */
  timedOut: boolean;
  /** True if the session was interrupted via the abort signal. */
  aborted: boolean;
}

export class ClaudeSession {
  constructor(private readonly logger: Logger) {}

  /**
   * Spawn a Claude Code session in interactive mode with the given prompt as
   * its initial user message. The session is considered "done" when the agent
   * writes `doneFlagPath`; we then ask claude to exit and wait for the process
   * to terminate. If the flag never appears, the timeout will force-kill it.
   */
  async run(options: ClaudeSessionOptions): Promise<ClaudeSessionResult> {
    const {
      cwd,
      prompt,
      doneFlagPath,
      timeoutMs,
      binary = "claude",
      extraArgs = [],
      env,
      signal,
    } = options;

    // Default permission mode for unattended runs. The TUI shows a y/n prompt
    // for every tool call in `default` mode and there is no human at the pty
    // to answer, so the session would hang on the first Bash/Write/Edit. Skip
    // the default only if the caller already set --permission-mode in
    // extraArgs (e.g. via CLAUDE_EXTRA_ARGS).
    const hasExplicitPermissionMode = extraArgs.some(
      (a) => a === "--permission-mode" || a.startsWith("--permission-mode="),
    );
    const defaultedArgs = hasExplicitPermissionMode
      ? extraArgs
      : ["--permission-mode", "bypassPermissions", ...extraArgs];

    const args = [...defaultedArgs, prompt];

    this.logger.info(
      {
        cwd,
        binary,
        extraArgs,
        doneFlagPath,
        timeoutMs,
      },
      "spawning claude session",
    );

    const child = pty.spawn(binary, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: {
        ...process.env,
        ...env,
      },
    });

    const state: {
      transcript: string;
      doneFlagSeen: boolean;
      timedOut: boolean;
      aborted: boolean;
      exit: { code: number | null; signal: number | null } | null;
    } = {
      transcript: "",
      doneFlagSeen: false,
      timedOut: false,
      aborted: false,
      exit: null,
    };

    child.onData((data) => {
      state.transcript += data;
      // Trim the transcript to a sane upper bound so we don't OOM on a chatty
      // session.
      const MAX = 256 * 1024;
      if (state.transcript.length > MAX) {
        state.transcript = state.transcript.slice(
          state.transcript.length - MAX,
        );
      }
    });

    const exitPromise = new Promise<void>((resolveExit) => {
      child.onExit(({ exitCode, signal }) => {
        state.exit = { code: exitCode, signal: signal ?? null };
        resolveExit();
      });
    });

    const startTime = Date.now();
    const pollInterval = 500;
    const exitGracePeriodMs = 15_000;

    let abortListener: (() => void) | null = null;
    await new Promise<void>((resolveFlag) => {
      const tick = (): void => {
        if (state.exit) {
          resolveFlag();
          return;
        }
        if (signal?.aborted && !state.aborted) {
          state.aborted = true;
          resolveFlag();
          return;
        }
        if (existsSync(doneFlagPath)) {
          state.doneFlagSeen = true;
          resolveFlag();
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          state.timedOut = true;
          resolveFlag();
          return;
        }
        setTimeout(tick, pollInterval);
      };
      if (signal && !signal.aborted) {
        abortListener = () => {
          state.aborted = true;
          resolveFlag();
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      tick();
    });
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }

    if (state.exit) {
      // Claude exited on its own before we saw the flag.
      this.logger.warn(
        {
          exitCode: state.exit.code,
          signal: state.exit.signal,
          doneFlagSeen: state.doneFlagSeen,
        },
        "claude exited before done flag detection finished",
      );
      return {
        exitCode: state.exit.code,
        signal: state.exit.signal,
        transcript: state.transcript,
        doneFlagSeen: state.doneFlagSeen,
        timedOut: false,
        aborted: state.aborted,
      };
    }

    if (state.doneFlagSeen) {
      this.logger.info("done flag observed, asking claude to exit");
      try {
        // Send /exit then Enter. If the TUI is showing a prompt, this triggers
        // a clean shutdown. If something else is focused, it falls back to the
        // SIGTERM below.
        child.write("/exit\r");
      } catch (err) {
        this.logger.warn({ err }, "failed to send /exit to claude pty");
      }
    } else if (state.aborted) {
      this.logger.warn(
        "claude session aborted by orchestrator (reviewer feedback)",
      );
      try {
        child.write("/exit\r");
      } catch (err) {
        this.logger.warn({ err }, "failed to send /exit to claude pty during abort");
      }
    } else if (state.timedOut) {
      this.logger.error(
        { timeoutMs },
        "claude session timed out before done flag",
      );
    }

    const exitTimer = setTimeout(() => {
      if (state.exit) return;
      this.logger.warn(
        "claude did not exit after /exit; sending SIGTERM",
      );
      try {
        child.kill("SIGTERM");
      } catch (err) {
        this.logger.warn({ err }, "SIGTERM failed");
      }
    }, exitGracePeriodMs);

    const hardKillTimer = setTimeout(
      () => {
        if (state.exit) return;
        this.logger.error("claude still alive after SIGTERM; sending SIGKILL");
        try {
          child.kill("SIGKILL");
        } catch (err) {
          this.logger.error({ err }, "SIGKILL failed");
        }
      },
      exitGracePeriodMs + 10_000,
    );

    await exitPromise;
    clearTimeout(exitTimer);
    clearTimeout(hardKillTimer);

    const exitInfo = state.exit ?? { code: null, signal: null };
    return {
      exitCode: exitInfo.code,
      signal: exitInfo.signal,
      transcript: state.transcript,
      doneFlagSeen: state.doneFlagSeen,
      timedOut: state.timedOut,
      aborted: state.aborted,
    };
  }
}
