// Verifies collector tick orchestration without live GitHub calls.
import { describe, expect, test } from "bun:test";

import { runCollectorTick, type CollectorStore } from "~/scheduler/collector";

const account = {
  id: 1024,
  login: "octocat",
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
});
