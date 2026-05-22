import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import type { Logger } from "./logger.js";

export interface DevServerHandle {
  port: number;
  url: string;
  pid: number;
  /** Tail of stdout/stderr (best-effort, capped). */
  recentOutput(): string;
  /** Stop the dev server (SIGTERM, then SIGKILL after grace). */
  stop(): Promise<void>;
}

export interface DevServerOptions {
  /** Directory to run `pnpm dev` in (the git worktree). */
  cwd: string;
  /** Port to bind the dev server to. */
  port: number;
  /** Max time to wait for the port to start responding (ms). */
  readyTimeoutMs?: number;
  /** Optional path under the dev server to probe (default "/"). */
  probePath?: string;
  /** Optional command + args override. Defaults to `pnpm dev`. */
  command?: { cmd: string; args: string[] };
  /** Extra env merged into the spawned process. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn `pnpm dev` in a worktree, wait until the configured port responds to
 * an HTTP request, and return a handle the caller can use to stop it.
 *
 * Resolution waits for either a successful HTTP response OR a process exit.
 * If the process dies before becoming reachable, we throw with the tailed
 * output so the orchestrator can log it and decide whether to continue
 * without a dev server.
 */
export async function startDevServer(
  logger: Logger,
  options: DevServerOptions,
): Promise<DevServerHandle> {
  const {
    cwd,
    port,
    readyTimeoutMs = 90_000,
    probePath = "/",
    command = { cmd: "pnpm", args: ["dev"] },
    env,
  } = options;

  const child = spawn(command.cmd, command.args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      // Suppress noisy color codes from being interpreted by anything that
      // captures stdout downstream.
      FORCE_COLOR: "0",
      NEXT_TELEMETRY_DISABLED: "1",
      // pnpm in a worktree with symlinked node_modules will sometimes try to
      // purge + reinstall, which prompts y/n on a TTY we don't have. CI=true
      // makes pnpm auto-confirm so the dev server can come up.
      CI: process.env["CI"] ?? "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (typeof child.pid !== "number") {
    throw new Error(`failed to spawn ${command.cmd} ${command.args.join(" ")}`);
  }

  const outputBuffer: string[] = [];
  const recordOutput = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    outputBuffer.push(text);
    // Cap at ~64 KB total to avoid OOM on chatty servers.
    let total = 0;
    for (let i = outputBuffer.length - 1; i >= 0; i--) {
      total += outputBuffer[i]!.length;
      if (total > 64 * 1024) {
        outputBuffer.splice(0, i + 1);
        break;
      }
    }
  };
  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);

  const recentOutput = (): string => outputBuffer.join("");

  const exitState: {
    value: { code: number | null; signal: NodeJS.Signals | null } | null;
  } = { value: null };
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitState.value = { code, signal };
      resolve();
    });
  });

  const url = `http://127.0.0.1:${port}`;
  logger.info({ cwd, port, pid: child.pid }, "dev server spawned, waiting for readiness");

  const readyDeadline = Date.now() + readyTimeoutMs;
  const probeInterval = 1_000;
  while (Date.now() < readyDeadline) {
    if (exitState.value) {
      throw new Error(
        `dev server exited before becoming ready (code=${exitState.value.code}, signal=${exitState.value.signal}). Recent output:\n${recentOutput().slice(-2_000)}`,
      );
    }
    const ok = await probeOnce(url, probePath, 2_000);
    if (ok) {
      logger.info({ port, pid: child.pid }, "dev server ready");
      return makeHandle(logger, child, port, url, recentOutput, exitPromise);
    }
    await new Promise((r) => setTimeout(r, probeInterval));
  }

  // Timed out — give up and kill it.
  await killChild(logger, child, exitPromise);
  throw new Error(
    `dev server did not respond on ${url}${probePath} within ${readyTimeoutMs}ms. Recent output:\n${recentOutput().slice(-2_000)}`,
  );
}

function makeHandle(
  logger: Logger,
  child: ChildProcess,
  port: number,
  url: string,
  recentOutput: () => string,
  exitPromise: Promise<void>,
): DevServerHandle {
  let stopped = false;
  return {
    port,
    url,
    pid: child.pid ?? -1,
    recentOutput,
    async stop() {
      if (stopped) return;
      stopped = true;
      await killChild(logger, child, exitPromise);
    },
  };
}

async function killChild(
  logger: Logger,
  child: ChildProcess,
  exitPromise: Promise<void>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch (err) {
    logger.warn({ err }, "SIGTERM to dev server failed");
  }
  const killed = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!killed) {
    logger.warn("dev server still alive after SIGTERM; sending SIGKILL");
    try {
      child.kill("SIGKILL");
    } catch (err) {
      logger.error({ err }, "SIGKILL to dev server failed");
    }
    await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
  }
}

function probeOnce(
  baseUrl: string,
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      `${baseUrl}${path}`,
      { method: "GET" },
      (res) => {
        // Any HTTP response means the server is up enough to be useful. We
        // don't care about the status code (Next dev returns 200, 307s for
        // auth redirects, 500s on first compile, etc.).
        res.resume();
        resolve(true);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}
