// Manages per-subscription delivery cron jobs.
import { Cron } from "croner";
import type { Api } from "grammy";

import type {
  SubscriptionDeliveryRecord,
  SubscriptionScheduleItem
} from "~/db/queries";
import type { StoredEvent } from "~/github/types";
import { applyFilters } from "~/filters/apply";
import { renderEventDigest } from "~/formatting/render";
import { writeDelivererHeartbeat } from "~/lifecycle/heartbeat";
import { createChildLogger, logger } from "~/lib/logger";
import {
  incrementDeliverySent,
  incrementTelegramApiError,
  observeDeliveryDuration
} from "~/lib/metrics";
import { createDeliveryQueue } from "~/scheduler/queue";
import { getScheduleCronExpression } from "~/scheduler/presets";

export type SubscriptionForDelivery = SubscriptionDeliveryRecord;

export type DeliveryStore = {
  getSubscriptionForDelivery: (
    subscriptionId: number
  ) => Promise<SubscriptionForDelivery | null>;
  listEventsForDelivery: (
    accountId: number,
    lastDeliveredAt: Date | null
  ) => Promise<StoredEvent[]>;
  updateSubscriptionDeliveryCursor: (
    subscriptionId: number,
    deliveredAt: Date
  ) => Promise<void>;
  writeDelivererHeartbeat: (date?: Date) => Promise<void>;
};

export type DeliverySendMessage = (
  chatId: number,
  text: string
) => Promise<void>;

export type DeliveryTaskInput = {
  subscriptionId: number;
};

export type DeliveryTaskOptions = DeliveryTaskInput & {
  store?: DeliveryStore;
  sendMessage: DeliverySendMessage;
  now?: Date;
};

export type DeliveryTaskResult = {
  status: "ok" | "empty" | "skipped" | "missing";
  eventCount: number;
  messageCount: number;
};

export type DelivererStore = DeliveryStore & {
  listActiveSubscriptionSchedules: () => Promise<SubscriptionScheduleItem[]>;
};

export type DeliveryScheduleOverride = {
  subscriptionId: number;
  cronExpression: string;
};

export type StartDelivererOptions = {
  api: Api;
  store?: DelivererStore;
  scheduleOverrides?: DeliveryScheduleOverride[];
  runImmediately?: boolean;
};

export type Deliverer = {
  stop: () => void;
  onIdle: () => Promise<void>;
  sync: () => Promise<void>;
  trigger: (subscriptionId: number) => Promise<void>;
};

const defaultStore: DelivererStore = {
  getSubscriptionForDelivery: async (subscriptionId) => {
    const queries = await import("~/db/queries");
    return queries.getSubscriptionForDelivery(subscriptionId);
  },
  listEventsForDelivery: async (accountId, lastDeliveredAt) => {
    const queries = await import("~/db/queries");
    return queries.listEventsForDelivery(accountId, lastDeliveredAt);
  },
  updateSubscriptionDeliveryCursor: async (subscriptionId, deliveredAt) => {
    const queries = await import("~/db/queries");
    await queries.updateSubscriptionDeliveryCursor(subscriptionId, deliveredAt);
  },
  writeDelivererHeartbeat,
  listActiveSubscriptionSchedules: async () => {
    const queries = await import("~/db/queries");
    return queries.listActiveSubscriptionSchedules();
  }
};

const newestCreatedAt = (events: StoredEvent[]): Date => {
  const [firstEvent, ...remainingEvents] = events;

  if (firstEvent === undefined) {
    throw new Error("cannot find newest event in an empty list");
  }

  return remainingEvents.reduce(
    (newest, event) =>
      event.createdAt.getTime() > newest.getTime() ? event.createdAt : newest,
    firstEvent.createdAt
  );
};

const repoNameMatchesSelection = (repoName: string, selectedRepo: string): boolean =>
  repoName === selectedRepo || repoName.endsWith(`/${selectedRepo}`);

const getTelegramErrorCode = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  if ("error_code" in error && typeof error.error_code === "number") {
    return error.error_code;
  }

  if (!("error" in error)) {
    return null;
  }

  const nested = error.error;

  if (typeof nested !== "object" || nested === null || !("error_code" in nested)) {
    return null;
  }

  return typeof nested.error_code === "number" ? nested.error_code : null;
};

const executeDeliveryTask = async (
  options: DeliveryTaskOptions,
  now: Date
): Promise<DeliveryTaskResult> => {
  const store = options.store ?? defaultStore;
  const subscription = await store.getSubscriptionForDelivery(
    options.subscriptionId
  );

  if (subscription === null) {
    logger.warn(
      { subscription_id: options.subscriptionId },
      "subscription missing for delivery"
    );

    return {
      status: "missing",
      eventCount: 0,
      messageCount: 0
    };
  }

  const taskLogger = createChildLogger({
    subscription_id: subscription.id,
    chat_id: subscription.chatId,
    account_login: subscription.accountLogin
  });
  const startedAt = Date.now();

  if (!subscription.chatActive || subscription.chatBanned) {
    taskLogger.debug("delivery skipped for inactive or banned chat");

    return {
      status: "skipped",
      eventCount: 0,
      messageCount: 0
    };
  }

  const events = await store.listEventsForDelivery(
    subscription.accountId,
    subscription.lastDeliveredAt
  );
  const selectedRepoEvents =
    subscription.selectedRepos === null
      ? events
      : events.filter((event) =>
          subscription.selectedRepos?.some((repo) =>
            repoNameMatchesSelection(event.repoName, repo)
          )
        );
  const matchingEvents = selectedRepoEvents.filter((event) =>
    applyFilters(subscription.filters, event)
  );

  if (matchingEvents.length === 0) {
    await store.updateSubscriptionDeliveryCursor(subscription.id, now);
    incrementDeliverySent("empty");
    taskLogger.debug(
      { source_event_count: events.length },
      "delivery had no matching events"
    );

    return {
      status: "empty",
      eventCount: 0,
      messageCount: 0
    };
  }

  const messages = renderEventDigest(matchingEvents);

  for (const message of messages) {
    await options.sendMessage(subscription.chatId, message);
  }

  await store.updateSubscriptionDeliveryCursor(
    subscription.id,
    newestCreatedAt(matchingEvents)
  );

  incrementDeliverySent("ok");
  observeDeliveryDuration(Date.now() - startedAt);
  taskLogger.info(
    {
      event_count: matchingEvents.length,
      message_count: messages.length,
      duration_ms: Date.now() - startedAt
    },
    "delivery complete"
  );

  return {
    status: "ok",
    eventCount: matchingEvents.length,
    messageCount: messages.length
  };
};

export const runDeliveryTask = async (
  options: DeliveryTaskOptions
): Promise<DeliveryTaskResult> => {
  const store = options.store ?? defaultStore;
  const now = options.now ?? new Date();
  let result: DeliveryTaskResult | null = null;
  let taskError: unknown = null;

  try {
    result = await executeDeliveryTask(options, now);
  } catch (error) {
    taskError = error;
    incrementDeliverySent("error");
    const telegramErrorCode = getTelegramErrorCode(error);

    if (telegramErrorCode !== null) {
      incrementTelegramApiError(telegramErrorCode);
    }

    logger.error(
      { err: error, subscription_id: options.subscriptionId },
      "delivery failed"
    );
  }

  try {
    await store.writeDelivererHeartbeat(now);
  } catch (heartbeatError) {
    logger.error({ err: heartbeatError }, "deliverer heartbeat failed");

    if (taskError === null) {
      throw heartbeatError;
    }
  }

  if (taskError !== null) {
    throw taskError;
  }

  if (result === null) {
    throw new Error("delivery task did not produce a result");
  }

  return result;
};

const createSendMessage =
  (api: Api): DeliverySendMessage =>
  async (chatId, text) => {
    await api.sendMessage(chatId, text);
  };

const getScheduleOverrideMap = (
  overrides: DeliveryScheduleOverride[] | undefined
): Map<number, string> =>
  new Map(
    (overrides ?? []).map((override) => [
      override.subscriptionId,
      override.cronExpression
    ])
  );

export const startDeliverer = (options: StartDelivererOptions): Deliverer => {
  const store = options.store ?? defaultStore;
  const jobs = new Map<number, Cron>();
  const scheduleOverrides = getScheduleOverrideMap(options.scheduleOverrides);
  const queue = createDeliveryQueue({
    deliver: (input) =>
      runDeliveryTask({
        subscriptionId: input.subscriptionId,
        store,
        sendMessage: createSendMessage(options.api)
      })
  });

  const stopJob = (subscriptionId: number): void => {
    jobs.get(subscriptionId)?.stop();
    jobs.delete(subscriptionId);
  };

  const scheduleJob = (item: SubscriptionScheduleItem): void => {
    stopJob(item.id);

    const cronExpression =
      scheduleOverrides.get(item.id) ??
      getScheduleCronExpression(item.schedulePreset);
    const job = new Cron(
      cronExpression,
      {
        timezone: item.timezone,
        protect: true,
        catch: (error) => {
          logger.error(
            { err: error, subscription_id: item.id },
            "delivery cron failed"
          );
        }
      },
      () => {
        void queue.addDelivery({ subscriptionId: item.id }).catch((error) => {
          logger.error(
            { err: error, subscription_id: item.id },
            "delivery queue task failed"
          );
        });
      }
    );

    jobs.set(item.id, job);
  };

  const sync = async (): Promise<void> => {
    const activeSubscriptions = await store.listActiveSubscriptionSchedules();
    const activeIds = new Set(activeSubscriptions.map((item) => item.id));

    for (const subscriptionId of jobs.keys()) {
      if (!activeIds.has(subscriptionId)) {
        stopJob(subscriptionId);
      }
    }

    for (const item of activeSubscriptions) {
      scheduleJob(item);

      if (options.runImmediately === true) {
        void queue.addDelivery({ subscriptionId: item.id }).catch((error) => {
          logger.error(
            { err: error, subscription_id: item.id },
            "delivery queue task failed"
          );
        });
      }
    }
  };

  void sync().catch((error) => {
    logger.error({ err: error }, "deliverer initial sync failed");
  });

  return {
    stop: () => {
      for (const job of jobs.values()) {
        job.stop();
      }

      jobs.clear();
    },
    onIdle: () => queue.onIdle(),
    sync,
    trigger: async (subscriptionId) => {
      await queue.addDelivery({ subscriptionId });
    }
  };
};
