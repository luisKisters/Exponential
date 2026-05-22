import { createServer } from "node:net";

/**
 * Probe `port` and return true if a server can bind to it on 0.0.0.0.
 * Synchronously safe — returns a Promise that resolves quickly.
 */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

/**
 * Find the first available TCP port starting at `from`, scanning upward.
 * Throws if no port is free in the [from, from + maxTries) range.
 */
export async function findAvailablePort(
  from: number = 3001,
  maxTries: number = 50,
): Promise<number> {
  for (let port = from; port < from + maxTries; port++) {
    if (await canBind(port)) {
      return port;
    }
  }
  throw new Error(
    `no free port found in range [${from}, ${from + maxTries})`,
  );
}
