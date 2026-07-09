// Verifies collector tick orchestration without live GitHub calls.
import { describe, expect, test } from "bun:test";

import {
  chooseAccountPollingMode,
  runCollectorTick,
  type CollectorStore
} from "~/scheduler/collector";

const account = {
  id: 1024,
  login: "octocat",
  etag: null,
  lastEventId: null,
  consecutiveFailures: 0,
  pausedUntil: null
};

const repo = {
  id: 1296269,
  accountId: account.id,
  ownerLogin: account.login,
  name: "hello-world",
  etag: null,
  lastEventId: null,
  consecutiveFailures: 0,
  pausedUntil: null
};

describe("collector tick", () => {
  test("polls all watched accounts and writes a heartbeat", async () => {
    const heartbeatWrites: Date[] = [];
    const store: CollectorStore = {
      listGitHubAccountsForPolling: async () => [account],
      writeCollectorHeartbeat: async (date) => {
        if (date === undefined) {
          throw new Error("expected heartbeat date");
        }
        heartbeatWrites.push(date);
      }
    };

    const result = await runCollectorTick({
      store,
      pollAccount: async (pollAccount) => ({
        status: "ok",
        accountId: pollAccount.id,
        login: pollAccount.login,
        fetchedCount: 3,
        insertedCount: 2,
        etag: "etag",
        lastEventId: "event-1"
      }),
      now: new Date("2026-05-20T12:00:00Z")
    });

    expect(result.accountCount).toBe(1);
    expect(result.insertedCount).toBe(2);
    expect(result.statusCounts.ok).toBe(1);
    expect(heartbeatWrites.map((date) => date.toISOString())).toEqual([
      "2026-05-20T12:00:00.000Z"
    ]);
  });

  test("writes a heartbeat when there are no accounts", async () => {
    const heartbeatWrites: Date[] = [];
    const store: CollectorStore = {
      listGitHubAccountsForPolling: async () => [],
      writeCollectorHeartbeat: async (date) => {
        if (date === undefined) {
          throw new Error("expected heartbeat date");
        }
        heartbeatWrites.push(date);
      }
    };

    const result = await runCollectorTick({
      store,
      pollAccount: async () => {
        throw new Error("should not poll");
      },
      now: new Date("2026-05-20T12:10:00Z")
    });

    expect(result.accountCount).toBe(0);
    expect(result.insertedCount).toBe(0);
    expect(heartbeatWrites.map((date) => date.toISOString())).toEqual([
      "2026-05-20T12:10:00.000Z"
    ]);
  });

  test("polls selected repos instead of the user firehose when under threshold", async () => {
    const polledRepos: string[] = [];
    const store: CollectorStore = {
      listGitHubAccountsForPolling: async () => [account],
      listActiveSubscriptionRepoSelectionsForAccount: async () => [
        { selectedRepos: ["hello-world"] }
      ],
      listGitHubReposForPolling: async (_accountId, names) =>
        names.includes(repo.name) ? [repo] : [],
      writeCollectorHeartbeat: async () => undefined
    };

    const result = await runCollectorTick({
      store,
      repoPollThreshold: 5,
      pollAccount: async () => {
        throw new Error("should not poll user firehose");
      },
      pollRepo: async (pollRepo) => {
        polledRepos.push(pollRepo.name);

        return {
          status: "ok",
          accountId: pollRepo.accountId,
          login: `${pollRepo.ownerLogin}/${pollRepo.name}`,
          fetchedCount: 2,
          insertedCount: 1,
          etag: "repo-etag",
          lastEventId: "repo-event"
        };
      }
    });

    expect(polledRepos).toEqual(["hello-world"]);
    expect(result.fetchedCount).toBe(2);
    expect(result.insertedCount).toBe(1);
  });

  test("skips polling accounts once shutdown begins", async () => {
    let polled = 0;
    const summary = await runCollectorTick({
      store: {
        listGitHubAccountsForPolling: async () => [
          { id: 1, login: "octocat", etag: null, lastEventId: null, consecutiveFailures: 0, pausedUntil: null }
        ],
        writeCollectorHeartbeat: async () => {}
      },
      pollAccount: async (pollAccount) => {
        polled += 1;
        return {
          status: "ok",
          accountId: pollAccount.id,
          login: pollAccount.login,
          fetchedCount: 0,
          insertedCount: 0,
          etag: null,
          lastEventId: null
        };
      },
      isShuttingDown: () => true
    });

    expect(polled).toBe(0);
    expect(summary.accountCount).toBe(1);
    expect(summary.fetchedCount).toBe(0);
  });
});

describe("chooseAccountPollingMode", () => {
  test("uses user firehose when any active subscription watches all repos", () => {
    expect(
      chooseAccountPollingMode(
        [
          { selectedRepos: ["linux"] },
          { selectedRepos: null }
        ],
        5
      )
    ).toEqual({ type: "user" });
  });

  test("uses repo polling when selected repo union is at or below threshold", () => {
    expect(
      chooseAccountPollingMode(
        [
          { selectedRepos: ["linux", "git"] },
          { selectedRepos: ["linux"] }
        ],
        5
      )
    ).toEqual({ type: "repos", repos: ["git", "linux"] });
  });

  test("falls back to user firehose when selected repo union exceeds threshold", () => {
    expect(
      chooseAccountPollingMode(
        [
          { selectedRepos: ["a", "b"] },
          { selectedRepos: ["c"] }
        ],
        2
      )
    ).toEqual({ type: "user" });
  });
});
