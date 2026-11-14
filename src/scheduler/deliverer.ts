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
import { renderRichAiDigest, renderRichEventDigest } from "~/formatting/rich";
import { writeDelivererHeartbeat } from "~/lifecycle/heartbeat";
import { shuttingDown } from "~/lifecycle/shutdown";
import { createChildLogger, logger } from "~/lib/logger";
import {
  incrementDeliverySent,
  incrementDigestFormat,
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

export type DigestFormat = "rich" | "html_fallback";

// One digest rendered both ways, so a rejected rich message can be resent as HTML.
export type Digest = { rich: string[]; html: string[] };

export type DeliveryTransport = {
  sendRich: (chatId: number, html: string) => Promise<void>;
  sendHtml: (chatId: number, html: string) => Promise<void>;
};

// The slice of grammY's Api the send path needs; Api itself satisfies it.
export type DeliveryApi = {
  sendRichMessage: (
    chatId: number,
    richMessage: { html: string; skip_entity_detection: boolean }
  ) => Promise<unknown>;
  sendMessage: (
    chatId: number,
    text: string,
    other: { link_preview_options: { is_disabled: boolean } }
  ) => Promise<unknown>;
};

export const createDeliveryTransport = (api: DeliveryApi): DeliveryTransport => ({
  sendRich: async (chatId, html) => {
    // Commit messages often mention @users, #issues and /paths; linking them is noise.
    await api.sendRichMessage(chatId, { html, skip_entity_detection: true });
  },
  sendHtml: async (chatId, html) => {
    await api.sendMessage(chatId, html, { link_preview_options: { is_disabled: true } });
  }
});

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
  transport: DeliveryTransport;
  enrichmentClient?: DeliveryEnrichmentClient;
  aiSummarizer?: AiSummarizer;
  now?: Date;
  isShuttingDown?: () => boolean;
};

export type DeliveryTaskResult = {
  status: "ok" | "empty" | "skipped" | "missing";
  eventCount: number;
  messageCount: number;
  format: DigestFormat | null;
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

export type SentDigest = { format: DigestFormat; messageCount: number };

// Only a rejection of the first part falls back to HTML: nothing has reached the
// chat yet. A failure on a later part throws so the cursor stays put and the
// next run retries. 429 and 5xx never get here, auto-retry handles them.
export const sendDigest = async (
  transport: DeliveryTransport,
  chatId: number,
  digest: Digest,
  taskLogger: Pick<typeof logger, "warn">
): Promise<SentDigest> => {
  const [first, ...rest] = digest.rich;

  if (first === undefined) {
    throw new Error("cannot send an empty digest");
  }

  try {
    await transport.sendRich(chatId, first);
  } catch (error) {
    if (getTelegramErrorCode(error) !== 400) {
      throw error;
    }

    // Not counted as a Telegram error: the digest still arrives, and the
    // fallback rate in digest_format_total is the signal to watch.
    taskLogger.warn({ err: error }, "rich digest rejected, sending HTML fallback");

    for (const message of digest.html) {
      await transport.sendHtml(chatId, message);
    }

    incrementDigestFormat("html_fallback");
    return { format: "html_fallback", messageCount: digest.html.length };
  }

  for (const message of rest) {
    await transport.sendRich(chatId, message);
  }

  incrementDigestFormat("rich");

  return { format: "rich", messageCount: digest.rich.length };
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
      messageCount: 0,
      format: null
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
      messageCount: 0,
      format: null
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
      messageCount: 0,
      format: null
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
      messageCount: 0,
      format: null
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
  const richOptions = {
    login: subscription.accountLogin,
    since: subscription.lastDeliveredAt,
    pullRequestDetails
  };
  let digest: Digest | null = null;

  if (subscription.aiSummary && aiSummarizer.isAvailable()) {
    try {
      const eventsByRepo = new Map<string, StoredEvent[]>();
      for (const event of matchingEvents) {
        const repoEvents = eventsByRepo.get(event.repoName) ?? [];
        repoEvents.push(event);
        eventsByRepo.set(event.repoName, repoEvents);
      }

      const repos = [...eventsByRepo];
      const results = await Promise.allSettled(
        repos.map(([, repoEvents]) =>
          aiSummarizer.generate(repoEvents, pullRequestDetails)
        )
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        throw rejected.reason;
      }

      const summaries = new Map<string, string>();
      for (const [index, [repoName]] of repos.entries()) {
        const result = results[index];
        if (result?.status !== "fulfilled" || !result.value?.trim()) {
          break;
        }
        summaries.set(repoName, result.value);
      }

      if (summaries.size !== repos.length) {
        taskLogger.warn("ai summary unavailable, falling back to standard digest");
      } else {
        digest = {
          rich: renderRichAiDigest(summaries, matchingEvents, richOptions),
          html: renderAiDigest(summaries)
        };
      }
    } catch (error) {
      taskLogger.warn({ err: error }, "ai summary threw, falling back to standard digest");
    }
  }

  if (digest === null) {
    digest = {
      rich: renderRichEventDigest(matchingEvents, richOptions),
      html: renderEventDigest(matchingEvents, { pullRequestDetails })
    };
  }

  const sent = await sendDigest(
    options.transport,
    subscription.chatId,
    digest,
    taskLogger
  );

  await store.updateSubscriptionDeliveryCursor(
    subscription.id,
    newestCreatedAt(matchingEvents)
  );

  incrementDeliverySent("ok");
  observeDeliveryDuration(Date.now() - startedAt);
  taskLogger.info(
    {
      event_count: matchingEvents.length,
      format: sent.format,
      message_count: sent.messageCount,
      duration_ms: Date.now() - startedAt
    },
    "delivery complete"
  );

  return {
    status: "ok",
    eventCount: matchingEvents.length,
    messageCount: sent.messageCount,
    format: sent.format
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
        transport: createDeliveryTransport(options.api),
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
            "delivery exceeded the queue budget and may still complete"
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
            "delivery exceeded the queue budget and may still complete"
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
