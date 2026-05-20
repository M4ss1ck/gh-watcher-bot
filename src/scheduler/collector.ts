// Runs the polling collector cron job and persists fetched events.
import { Cron } from "croner";
import PQueue from "p-queue";

import type { GitHubAccountForPolling } from "~/db/queries";
import { createGitHubClient, type GitHubApiClient } from "~/github/client";
import { pollGitHubAccount, type PollResult } from "~/github/poller";
import { writeCollectorHeartbeat } from "~/lifecycle/heartbeat";
import { logger } from "~/lib/logger";

export type CollectorStore = {
  listGitHubAccountsForPolling: () => Promise<GitHubAccountForPolling[]>;
  writeCollectorHeartbeat: (date?: Date) => Promise<void>;
};

export type PollAccount = (
  account: GitHubAccountForPolling
) => Promise<PollResult>;

export type CollectorTickOptions = {
  store?: CollectorStore;
  pollAccount?: PollAccount;
  concurrency?: number;
  now?: Date;
};

export type CollectorTickSummary = {
  accountCount: number;
  fetchedCount: number;
  insertedCount: number;
  durationMs: number;
  statusCounts: Record<PollResult["status"], number>;
};

export type CollectorJob = {
  stop: () => void;
  trigger: () => Promise<void>;
};

export type StartCollectorOptions = {
  cronExpression: string;
  client?: GitHubApiClient;
  store?: CollectorStore;
  runImmediately?: boolean;
};

const defaultStore: CollectorStore = {
  listGitHubAccountsForPolling: async () => {
    const queries = await import("~/db/queries");
    return queries.listGitHubAccountsForPolling();
  },
  writeCollectorHeartbeat
};

const emptyStatusCounts = (): Record<PollResult["status"], number> => ({
  ok: 0,
  not_modified: 0,
  skipped_paused: 0,
  failed: 0
});

export const runCollectorTick = async (
  options: CollectorTickOptions = {}
): Promise<CollectorTickSummary> => {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const store = options.store ?? defaultStore;
  const accounts = await store.listGitHubAccountsForPolling();
  const queue = new PQueue({ concurrency: options.concurrency ?? 5 });
  const pollAccount =
    options.pollAccount ??
    (async (account: GitHubAccountForPolling) =>
      pollGitHubAccount(account, { client: createGitHubClient(), now }));

  const results = await Promise.all(
    accounts.map((account) => queue.add(() => pollAccount(account)))
  );
  const statusCounts = emptyStatusCounts();
  let fetchedCount = 0;
  let insertedCount = 0;

  for (const result of results) {
    statusCounts[result.status] += 1;
    fetchedCount += result.fetchedCount;
    insertedCount += result.insertedCount;
  }

  await store.writeCollectorHeartbeat(now);

  return {
    accountCount: accounts.length,
    fetchedCount,
    insertedCount,
    durationMs: Date.now() - startedAt,
    statusCounts
  };
};

export const startCollector = (options: StartCollectorOptions): CollectorJob => {
  const client = options.client ?? createGitHubClient();
  const store = options.store ?? defaultStore;
  const run = async (): Promise<void> => {
    const summary = await runCollectorTick({
      store,
      pollAccount: (account) => pollGitHubAccount(account, { client }),
      now: new Date()
    });

    logger.info(
      {
        account_count: summary.accountCount,
        fetched_count: summary.fetchedCount,
        inserted_count: summary.insertedCount,
        duration_ms: summary.durationMs,
        status_counts: summary.statusCounts
      },
      "collector tick complete"
    );
  };
  const job = new Cron(
    options.cronExpression,
    {
      protect: true,
      catch: (error) => {
        logger.error({ err: error }, "collector tick failed");
      }
    },
    run
  );

  if (options.runImmediately === true) {
    void job.trigger();
  }

  return {
    stop: () => {
      job.stop();
    },
    trigger: () => job.trigger()
  };
};
