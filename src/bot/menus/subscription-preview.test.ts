// Verifies the manual preview flow refreshes GitHub events before delivery.
import { describe, expect, test } from "bun:test";

import type { GitHubAccountForPolling } from "~/db/queries";
import type { GitHubEventsClient } from "~/github/poller";
import { runSubscriptionPreview } from "~/bot/menus/subscription";

const account: GitHubAccountForPolling = {
  id: 583231,
  login: "torvalds",
  etag: null,
  lastEventId: null,
  consecutiveFailures: 0,
  pausedUntil: null
};

const client: GitHubEventsClient = {
  fetchUserEvents: async () => ({
    status: 200,
    headers: {},
    data: []
  }),
  fetchRepoEvents: async () => ({
    status: 200,
    headers: {},
    data: []
  })
};

describe("runSubscriptionPreview", () => {
  test("force-polls the account before delivery and sends a real empty message", async () => {
    const calls: string[] = [];
    const replies: string[] = [];

    await runSubscriptionPreview({
      subscriptionId: 91,
      accountId: account.id,
      accountLogin: account.login,
      client,
      getAccountById: async (accountId) => {
        calls.push(`get:${accountId}`);

        return account;
      },
      pollAccount: async (pollAccount) => {
        calls.push(`poll:${pollAccount.login}`);

        return {
          status: "not_modified",
          accountId: pollAccount.id,
          login: pollAccount.login,
          fetchedCount: 0,
          insertedCount: 0,
          etag: pollAccount.etag
        };
      },
      deliver: async ({ subscriptionId }) => {
        calls.push(`deliver:${subscriptionId}`);

        return {
          status: "empty",
          eventCount: 0,
          messageCount: 0
        };
      },
      sendMessage: async () => {
        throw new Error("empty preview should use reply");
      },
      reply: async (text) => {
        replies.push(text);
      }
    });

    expect(calls).toEqual(["get:583231", "poll:torvalds", "deliver:91"]);
    expect(replies).toEqual([
      "No new events for <code>@torvalds</code> since last delivery. The collector polls every 10 min."
    ]);
  });

  test("reports GitHub refresh failures without running delivery", async () => {
    const calls: string[] = [];
    const replies: string[] = [];

    await runSubscriptionPreview({
      subscriptionId: 91,
      accountId: account.id,
      accountLogin: account.login,
      client,
      getAccountById: async () => account,
      pollAccount: async () => ({
        status: "failed",
        accountId: account.id,
        login: account.login,
        fetchedCount: 0,
        insertedCount: 0,
        consecutiveFailures: 1,
        pausedUntil: null,
        failureStatus: 403
      }),
      deliver: async () => {
        calls.push("deliver");

        return {
          status: "ok",
          eventCount: 1,
          messageCount: 1
        };
      },
      sendMessage: async () => undefined,
      reply: async (text) => {
        replies.push(text);
      }
    });

    expect(calls).toEqual([]);
    expect(replies).toEqual([
      "Could not refresh <code>@torvalds</code> before preview. GitHub returned 403."
    ]);
  });
});
