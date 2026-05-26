/**
 * Orchestrator-side `pnpm build` gate. Phase 6 runs the build itself after each
 * phase session rather than trusting the agent's self-reported verdict — the
 * agent claims `phase-ok`, but this is the authoritative green/red signal that
 * decides whether the phase actually passed.
 */
import { spawn } from "node:child_process";

export interface PnpmBuildResult {
  /** True iff the process exited 0 and we didn't have to kill it for the timeout. */
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Combined stdout+stderr, tail-capped (~50 KB) so a chatty build can't OOM us. */
  output: string;
}

const OUTPUT_CAP = 50 * 1024;

/**
 * Run `pnpm build` in `cwd`. Never rejects — failures (non-zero exit, spawn
 * error, timeout) come back as `ok: false` with the captured output, so the
 * caller can fold the log into memory.md.
 */
export function runPnpmBuild(
  cwd: string,
  timeoutMs: number,
  binary = "pnpm",
): Promise<PnpmBuildResult> {
  return new Promise((resolveBuild) => {
    const child = spawn(binary, ["build"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const append = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > OUTPUT_CAP) {
        output = output.slice(output.length - OUTPUT_CAP);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 5_000);
      killTimer.unref();
    }, timeoutMs);

    const finish = (res: PnpmBuildResult): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveBuild(res);
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        output: `${output}\nspawn error: ${err instanceof Error ? err.message : String(err)}`,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        output,
      });
    });
  });
}
