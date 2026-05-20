// Starts the bot process and waits for a shutdown signal.
import { createBot } from "~/bot";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { startCollector } from "~/scheduler/collector";
import { startDeliverer } from "~/scheduler/deliverer";

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

const main = async (): Promise<void> => {
  logger.debug({ node_env: env.NODE_ENV }, "environment loaded");
  logger.info("starting");

  const bot = createBot();
  const collector = startCollector({
    cronExpression: env.POLL_INTERVAL_CRON
  });
  const deliverer = startDeliverer({
    api: bot.api
  });

  const botRun = bot.start({
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    onStart: (botInfo) => {
      logger.info({ bot_username: botInfo.username }, "bot started");
    }
  });

  const result = await Promise.race([
    waitForShutdownSignal().then((signal) => ({ type: "signal" as const, signal })),
    botRun.then(() => ({ type: "bot_stopped" as const }))
  ]);

  if (result.type === "bot_stopped") {
    logger.warn("bot polling stopped");
    collector.stop();
    deliverer.stop();
    await deliverer.onIdle();
    return;
  }

  logger.info({ signal: result.signal }, "shutdown requested");

  collector.stop();
  deliverer.stop();
  await deliverer.onIdle();
  await bot.stop();
  await botRun;

  logger.info("stopped");
};

try {
  await main();
} catch (error) {
  logger.error({ err: error }, "fatal startup error");
  process.exit(1);
}
