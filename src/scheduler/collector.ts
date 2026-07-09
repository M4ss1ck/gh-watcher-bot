// Runs the polling collector cron job and persists fetched events.
import { Cron } from "croner";
import PQueue from "p-queue";

import type {
  GitHubAccountForPolling,
  GitHubRepoForPolling
} from "~/db/queries";
import { createGitHubClient, type GitHubApiClient } from "~/github/client";
import {
  pollGitHubAccount,
  pollGitHubRepo,
  type PollResult
} from "~/github/poller";
import { writeCollectorHeartbeat } from "~/lifecycle/heartbeat";
import { shuttingDown } from "~/lifecycle/shutdown";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

export type CollectorStore = {
  listGitHubAccountsForPolling: () => Promise<GitHubAccountForPolling[]>;
  listActiveSubscriptionRepoSelectionsForAccount?: (
    accountId: number
  ) => Promise<AccountRepoSelection[]>;
  listGitHubReposForPolling?: (
    accountId: number,
    names: string[]
  ) => Promise<GitHubRepoForPolling[]>;
  writeCollectorHeartbeat: (date?: Date) => Promise<void>;
};

export type AccountRepoSelection = {
  selectedRepos: string[] | null;
};

export type AccountPollingMode =
  | { type: "user" }
  | { type: "repos"; repos: string[] };

export type PollAccount = (
  account: GitHubAccountForPolling
) => Promise<PollResult>;

export type PollRepo = (repo: GitHubRepoForPolling) => Promise<PollResult>;

export type CollectorTickOptions = {
  store?: CollectorStore;
  pollAccount?: PollAccount;
  pollRepo?: PollRepo;
  concurrency?: number;
  repoPollThreshold?: number;
  now?: Date;
  isShuttingDown?: () => boolean;
  client?: GitHubApiClient;
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
  listActiveSubscriptionRepoSelectionsForAccount: async (accountId) => {
    const queries = await import("~/db/queries");
    return queries.listActiveSubscriptionRepoSelectionsForAccount(accountId);
  },
  listGitHubReposForPolling: async (accountId, names) => {
    const queries = await import("~/db/queries");
    return queries.listGitHubReposForPolling(accountId, names);
  },
  writeCollectorHeartbeat
};

const emptyStatusCounts = (): Record<PollResult["status"], number> => ({
  ok: 0,
  not_modified: 0,
  skipped_paused: 0,
  failed: 0
});

export const chooseAccountPollingMode = (
  selections: AccountRepoSelection[],
  repoPollThreshold: number
): AccountPollingMode => {
  if (
    selections.length === 0 ||
    selections.some((selection) => selection.selectedRepos === null)
  ) {
    return { type: "user" };
  }

  const repos = [
    ...new Set(selections.flatMap((selection) => selection.selectedRepos ?? []))
  ].sort();

  return repos.length <= repoPollThreshold
    ? { type: "repos", repos }
    : { type: "user" };
};

export const runCollectorTick = async (
  options: CollectorTickOptions = {}
): Promise<CollectorTickSummary> => {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const store = options.store ?? defaultStore;
  const isShuttingDown = options.isShuttingDown ?? (() => shuttingDown);
  const accounts = await store.listGitHubAccountsForPolling();
  const queue = new PQueue({ concurrency: options.concurrency ?? 5 });
  const client = options.client ?? createGitHubClient();
  const pollAccount =
    options.pollAccount ??
    (async (account: GitHubAccountForPolling) =>
      pollGitHubAccount(account, { client, now }));
  const pollRepo =
    options.pollRepo ??
    (async (repo: GitHubRepoForPolling) =>
      pollGitHubRepo(repo, { client, now }));
  const pollAccountByMode = async (
    account: GitHubAccountForPolling
  ): Promise<PollResult[]> => {
    if (isShuttingDown()) {
      return [];
    }

    if (
      store.listActiveSubscriptionRepoSelectionsForAccount === undefined ||
      store.listGitHubReposForPolling === undefined
    ) {
      return [await pollAccount(account)];
    }

    const selections = await store.listActiveSubscriptionRepoSelectionsForAccount(
      account.id
    );
    const mode = chooseAccountPollingMode(
      selections,
      options.repoPollThreshold ?? env.REPO_POLL_THRESHOLD
    );

    if (mode.type === "user") {
      return [await pollAccount(account)];
    }

    const repos = await store.listGitHubReposForPolling(account.id, mode.repos);

    return Promise.all(repos.map((repo) => pollRepo(repo)));
  };

  const results = await Promise.all(
    accounts.map((account) => queue.add(() => pollAccountByMode(account)))
  ).then((groups) => groups.flat());
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
      client,
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
