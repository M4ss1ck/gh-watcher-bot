// Runs the deliverer with an optional one-subscription cron override.
import { createBot } from "~/bot";
import { logger } from "~/lib/logger";
import { startDeliverer, type DeliveryScheduleOverride } from "~/scheduler/deliverer";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

const args = new Map(
  Bun.argv.slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value] = arg.slice(2).split("=", 2);
      return [key, value ?? "true"] as const;
    })
);

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

const getOptionalNumberArg = (name: string): number | null => {
  const value = args.get(name);

  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--${name} must be a safe integer`);
  }

  return parsed;
};

const subscriptionId = getOptionalNumberArg("subscription-id");
const cronExpression = args.get("cron") ?? "* * * * *";
const overrides: DeliveryScheduleOverride[] =
  subscriptionId === null
    ? []
    : [
        {
          subscriptionId,
          cronExpression
        }
      ];

const bot = createBot();
const deliverer = startDeliverer({
  api: bot.api,
  scheduleOverrides: overrides,
  runImmediately: args.get("run-immediately") === "true"
});

logger.info(
  {
    override_subscription_id: subscriptionId,
    override_cron: subscriptionId === null ? null : cronExpression
  },
  "deliverer runner starting"
);

const signal = await waitForShutdownSignal();

logger.info({ signal }, "deliverer runner stopping");
deliverer.stop();
await deliverer.onIdle();
logger.info("deliverer runner stopped");
