import { loadConfig } from "./config.js";
import { startHealthServer, type HealthServerHandle } from "./health.js";
import { createLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { PlaneApi } from "./plane.js";
import { Store } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info(
    {
      planeBaseUrl: config.plane.baseUrl,
      workspaceSlug: config.plane.workspaceSlug,
      projectId: config.plane.projectId,
      databasePath: config.databasePath,
    },
    "starting exponential",
  );

  const store = new Store(logger, config.databasePath);
  const plane = new PlaneApi(
    logger,
    config.plane.workspaceSlug,
    config.plane.projectId,
    config.plane.baseUrl,
    config.plane.apiKey,
  );
  const orchestrator = new Orchestrator(logger, config, plane, store);
  let healthServer: HealthServerHandle | null = null;

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "received shutdown signal");
    if (healthServer) {
      try {
        await healthServer.close();
      } catch (err) {
        logger.error({ err }, "error closing health server");
      }
    }
    try {
      await orchestrator.stop();
    } catch (err) {
      logger.error({ err }, "error during orchestrator shutdown");
    }
    try {
      store.close();
    } catch (err) {
      logger.error({ err }, "error closing store");
    }
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", (sig) => void shutdown(sig));
  process.on("SIGINT", (sig) => void shutdown(sig));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    process.exit(1);
  });

  await orchestrator.start();

  if (config.health.port > 0) {
    healthServer = await startHealthServer(
      logger,
      config.health.host,
      config.health.port,
      () => orchestrator.getHealth(),
    );
  } else {
    logger.info("health server disabled (HEALTH_PORT=0)");
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({
      level: "fatal",
      service: "exponential",
      time: new Date().toISOString(),
      msg: "startup failed",
      error: message,
    }),
  );
  process.exit(1);
});
