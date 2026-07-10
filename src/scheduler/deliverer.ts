// Manages per-subscription delivery cron jobs.
import { Cron } from "croner";
import type { Api } from "grammy";

import type {
  SubscriptionDeliveryRecord,
  SubscriptionScheduleItem
} from "~/db/queries";
import type { GitHubApiClient } from "~/github/client";
import type { GitHubPullRequestDetail, StoredEvent } from "~/github/types";
import { generateAiSummary, isAiSummaryAvailable } from "~/ai/summary";
import { applyFilters } from "~/filters/apply";
import { renderAiDigest, renderEventDigest } from "~/formatting/render";
import { writeDelivererHeartbeat } from "~/lifecycle/heartbeat";
import { shuttingDown } from "~/lifecycle/shutdown";
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

export type DeliveryEnrichmentClient = Pick<GitHubApiClient, "getPullRequest">;

export type AiSummarizer = {
  isAvailable: () => boolean;
  generate: (
    events: StoredEvent[],
    pullRequestDetails: Map<string, GitHubPullRequestDetail>
  ) => Promise<string | null>;
};

const defaultAiSummarizer: AiSummarizer = {
  isAvailable: isAiSummaryAvailable,
  generate: (events, pullRequestDetails) =>
    generateAiSummary(events, { pullRequestDetails })
};

export type DeliveryTaskOptions = DeliveryTaskInput & {
  store?: DeliveryStore;
  sendMessage: DeliverySendMessage;
  enrichmentClient?: DeliveryEnrichmentClient;
  aiSummarizer?: AiSummarizer;
  now?: Date;
  isShuttingDown?: () => boolean;
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
  pollIntervalCron?: string;
  runImmediately?: boolean;
  enrichmentClient?: DeliveryEnrichmentClient;
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

const isMergedPullRequestEvent = (event: StoredEvent): boolean => {
  if (event.type !== "PullRequestEvent") {
    return false;
  }

  const action =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>).action
      : null;

  return action === "merged";
};

const getMergedPullRequestNumber = (event: StoredEvent): number | null => {
  const payload = event.payload as Record<string, unknown>;
  const pullRequest = payload.pull_request;

  if (typeof pullRequest === "object" && pullRequest !== null) {
    const number = (pullRequest as Record<string, unknown>).number;

    if (typeof number === "number") {
      return number;
    }
  }

  const top = payload.number;

  return typeof top === "number" ? top : null;
};

const splitRepoName = (repoName: string): { owner: string; repo: string } | null => {
  const [owner, repo] = repoName.split("/", 2);

  return owner !== undefined && repo !== undefined ? { owner, repo } : null;
};

const enrichMergedPullRequests = async (
  events: StoredEvent[],
  client: DeliveryEnrichmentClient,
  taskLogger: ReturnType<typeof createChildLogger>
): Promise<Map<string, GitHubPullRequestDetail>> => {
  const targets = events
    .filter(isMergedPullRequestEvent)
    .map((event) => {
      const number = getMergedPullRequestNumber(event);
      const repo = splitRepoName(event.repoName);

      return number === null || repo === null
        ? null
        : { event, number, owner: repo.owner, repo: repo.repo };
    })
    .filter((target): target is NonNullable<typeof target> => target !== null);

  const entries = await Promise.all(
    targets.map(async (target) => {
      try {
        const detail = await client.getPullRequest(
          target.owner,
          target.repo,
          target.number
        );

        return [target.event.id, detail] as const;
      } catch (error) {
        taskLogger.warn(
          {
            err: error,
            event_id: target.event.id,
            repo: target.event.repoName,
            pr_number: target.number
          },
          "merged pull request enrichment failed"
        );

        return null;
      }
    })
  );

  return new Map(
    entries.filter((entry): entry is readonly [string, GitHubPullRequestDetail] =>
      entry !== null
    )
  );
};

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
  const isShuttingDown = options.isShuttingDown ?? (() => shuttingDown);

  if (isShuttingDown()) {
    logger.debug(
      { subscription_id: options.subscriptionId },
      "delivery skipped during shutdown"
    );

    return {
      status: "skipped",
      eventCount: 0,
      messageCount: 0
    };
  }

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
    // Only advance the cursor past events we have actually seen. Advancing
    // to `now` here would silently skip events that the collector inserts
    // moments later (the as_fetched schedule races with the collector cron
    // since both use the same expression).
    if (events.length > 0) {
      await store.updateSubscriptionDeliveryCursor(
        subscription.id,
        newestCreatedAt(events)
      );
    }
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

  const pullRequestDetails =
    subscription.filters.enrichMergedPullRequests && options.enrichmentClient
      ? await enrichMergedPullRequests(
          matchingEvents,
          options.enrichmentClient,
          taskLogger
        )
      : new Map<string, GitHubPullRequestDetail>();

  const aiSummarizer = options.aiSummarizer ?? defaultAiSummarizer;
  let messages: string[] | null = null;

  if (subscription.aiSummary && aiSummarizer.isAvailable()) {
    try {
      const summaryText = await aiSummarizer.generate(
        matchingEvents,
        pullRequestDetails
      );

      if (summaryText === null) {
        taskLogger.warn("ai summary unavailable, falling back to standard digest");
      } else {
        messages = [renderAiDigest(summaryText, matchingEvents)];
      }
    } catch (error) {
      taskLogger.warn({ err: error }, "ai summary threw, falling back to standard digest");
    }
  }

  if (messages === null) {
    messages = renderEventDigest(matchingEvents, { pullRequestDetails });
  }

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
    await api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true }
    });
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
        sendMessage: createSendMessage(options.api),
        enrichmentClient: options.enrichmentClient
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
      getScheduleCronExpression(item.schedulePreset, options.pollIntervalCron);
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
