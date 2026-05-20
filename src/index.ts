// Starts the process and waits for a shutdown signal.
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

logger.debug({ node_env: env.NODE_ENV }, "environment loaded");
logger.info("starting");

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

await new Promise<void>((resolve) => {
  const stop = (signal: (typeof shutdownSignals)[number]) => {
    for (const shutdownSignal of shutdownSignals) {
      process.off(shutdownSignal, stop);
    }

    logger.info({ signal }, "shutdown requested");
    resolve();
  };

  for (const signal of shutdownSignals) {
    process.once(signal, stop);
  }
});

logger.info("stopped");
