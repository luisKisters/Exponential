/**
 * Phase 8: a tiny HTTP health endpoint for container orchestration. Docker's
 * `HEALTHCHECK` and Coolify's health check both poll a URL and read the status
 * code; this returns 200 while the orchestrator's poll loop is alive (or still
 * booting) and 503 once it has gone stale or stopped. The JSON body carries the
 * detail (uptime, last poll, in-flight issue) for humans hitting it directly.
 *
 * Deliberately dependency-free (`node:http`) — the orchestrator already has
 * enough moving parts without pulling in a web framework for one route.
 */
import { createServer } from "node:http";
import type { Logger } from "./logger.js";

export interface HealthServerHandle {
  close(): Promise<void>;
}

/**
 * Snapshot shape the server serializes. Only `status` is required (it drives the
 * HTTP code); the rest of the object is serialized as-is into the JSON body.
 */
export interface HealthPayload {
  status: "ok" | "starting" | "stale" | "stopped";
}

const HEALTH_PATHS = new Set(["/", "/health", "/healthz"]);

export function startHealthServer(
  logger: Logger,
  host: string,
  port: number,
  snapshot: () => HealthPayload,
): Promise<HealthServerHandle> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method !== "GET" || !HEALTH_PATHS.has(path)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const payload = snapshot();
    const healthy = payload.status === "ok" || payload.status === "starting";
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      logger.info({ host, port }, "health server listening");
      resolve({
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
