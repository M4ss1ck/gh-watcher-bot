// Verifies the manual preview flow refreshes GitHub events before delivery.
import { describe, expect, test } from "bun:test";

import type { GitHubAccountForPolling } from "~/db/queries";
import type { GitHubEventsClient } from "~/github/poller";
import { runSubscriptionPreview } from "~/bot/menus/subscription";
import type { DeliveryApi } from "~/scheduler/deliverer";

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

const unusedApi: DeliveryApi = {
  sendRichMessage: async () => {
    throw new Error("unexpected rich send");
  },
  sendMessage: async () => {
    throw new Error("unexpected HTML send");
  }
};

describe("runSubscriptionPreview", () => {
  test("delivers through the shared rich transport", async () => {
    const calls: unknown[][] = [];

    await runSubscriptionPreview({
      subscriptionId: 91,
      accountId: account.id,
      accountLogin: account.login,
      client,
      getAccountById: async () => account,
      pollAccount: async (pollAccount) => ({
        status: "not_modified",
        accountId: pollAccount.id,
        login: pollAccount.login,
        fetchedCount: 0,
        insertedCount: 0,
        etag: pollAccount.etag
      }),
      deliver: async ({ transport }) => {
        await transport.sendRich(42, "<p>digest</p>");

        return { status: "ok", eventCount: 1, messageCount: 1, format: "rich" };
      },
      api: {
        sendRichMessage: async (...args) => {
          calls.push(args);
        },
        sendMessage: async () => {
          throw new Error("unexpected HTML send");
        }
      },
      reply: async () => undefined
    });

    expect(calls).toEqual([[42, { html: "<p>digest</p>", skip_entity_detection: true }]]);
  });

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
          messageCount: 0,
          format: null
        };
      },
      api: unusedApi,
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
          messageCount: 1,
          format: "rich"
        };
      },
      api: unusedApi,
      reply: async (text) => {
        replies.push(text);
      }
    });

    expect(calls).toEqual([]);
    expect(replies).toEqual([
      "Could not refresh <code>@torvalds</code> before preview. GitHub returned 403."
    ]);
  });

  test("reports paused polling in the subscription timezone", async () => {
    const replies: string[] = [];

    await runSubscriptionPreview({
      subscriptionId: 91,
      accountId: account.id,
      accountLogin: account.login,
      timezone: "America/Santiago",
      client,
      getAccountById: async () => account,
      pollAccount: async () => ({
        status: "skipped_paused",
        accountId: account.id,
        login: account.login,
        fetchedCount: 0,
        insertedCount: 0,
        pausedUntil: new Date("2026-05-20T12:00:00Z")
      }),
      deliver: async () => {
        throw new Error("should not deliver");
      },
      api: unusedApi,
      reply: async (text) => {
        replies.push(text);
      }
    });

    expect(replies).toEqual([
      "GitHub polling for <code>@torvalds</code> is paused until 2026-05-20 08:00 America/Santiago."
    ]);
  });
});
