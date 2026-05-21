// Starts the bot process and waits for a shutdown signal.
import { createBot } from "~/bot";
import { libsqlClient } from "~/db/client";
import { runMigrations } from "~/db/migrate";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { setupShutdown } from "~/lifecycle/shutdown";
import { startCollector } from "~/scheduler/collector";
import { startDeliverer } from "~/scheduler/deliverer";

const main = async (): Promise<void> => {
  logger.debug({ node_env: env.NODE_ENV }, "environment loaded");
  logger.info("starting");

  await runMigrations();

  const bot = createBot();
  // runImmediately writes the first heartbeat at boot so the Docker healthcheck
  // does not spend the first cron interval reporting "no collector heartbeat".
  const collector = startCollector({
    cronExpression: env.POLL_INTERVAL_CRON,
    runImmediately: true
  });
  const deliverer = startDeliverer({
    api: bot.api
  });
  const shutdown = setupShutdown({
    bot,
    collector,
    deliverer,
    db: libsqlClient
  });

  void bot
    .start({
      allowed_updates: ["message", "callback_query", "my_chat_member"],
      onStart: (botInfo) => {
        logger.info({ bot_username: botInfo.username }, "bot started");
      }
    })
    .then(() => {
      shutdown.trigger("bot_stopped");
    })
    .catch((error) => {
      logger.error({ err: error }, "bot polling crashed");
      shutdown.trigger("bot_crashed");
    });

  await shutdown.done;
};

try {
  await main();
} catch (error) {
  logger.error({ err: error }, "fatal startup error");
  process.exit(1);
}
