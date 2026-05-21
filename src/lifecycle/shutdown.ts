// Coordinates graceful shutdown across bot, schedulers, queues, and database.
import type { Bot } from "grammy";

import { logger } from "~/lib/logger";
import type { CollectorJob } from "~/scheduler/collector";
import type { Deliverer } from "~/scheduler/deliverer";

export let shuttingDown = false;

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;
const shutdownDeadlineMs = 25_000;

export type ShutdownTargets = {
  bot: Bot;
  collector: CollectorJob;
  deliverer: Deliverer;
  db: { close(): void };
};

export type ShutdownHandle = {
  done: Promise<void>;
  trigger: (reason: string) => void;
};

export const setupShutdown = (targets: ShutdownTargets): ShutdownHandle => {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const run = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ reason }, "shutdown requested");

    const watchdog = setTimeout(() => {
      logger.warn({ deadline_ms: shutdownDeadlineMs }, "shutdown exceeded deadline, forcing exit");
      process.exit(1);
    }, shutdownDeadlineMs);
    watchdog.unref?.();

    try {
      targets.collector.stop();
      targets.deliverer.stop();
      await targets.deliverer.onIdle();
      await targets.bot.stop();
      targets.db.close();
    } catch (error) {
      logger.error({ err: error }, "shutdown encountered error");
    } finally {
      clearTimeout(watchdog);
    }

    logger.info("stopped");
    resolveDone();
  };

  for (const signal of shutdownSignals) {
    process.once(signal, () => {
      void run(signal);
    });
  }

  return {
    done,
    trigger: (reason) => {
      void run(reason);
    }
  };
};
