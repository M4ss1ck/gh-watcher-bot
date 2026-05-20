// Runs only the collector job for local observation.
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { startCollector } from "~/scheduler/collector";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

const waitForShutdownSignal = async (): Promise<(typeof shutdownSignals)[number]> =>
  new Promise((resolve) => {
    const stop = (signal: (typeof shutdownSignals)[number]) => {
      for (const shutdownSignal of shutdownSignals) {
        process.off(shutdownSignal, stop);
      }

      resolve(signal);
    };

    for (const signal of shutdownSignals) {
      process.once(signal, stop);
    }
  });

logger.info({ cron: env.POLL_INTERVAL_CRON }, "collector runner starting");

const collector = startCollector({
  cronExpression: env.POLL_INTERVAL_CRON,
  runImmediately: true
});
const signal = await waitForShutdownSignal();

logger.info({ signal }, "collector runner stopping");
collector.stop();
logger.info("collector runner stopped");
