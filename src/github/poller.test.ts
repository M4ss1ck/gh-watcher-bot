// Verifies GitHub polling behavior without live GitHub calls.
import { describe, expect, test } from "bun:test";

import {
  pollGitHubAccount,
  type GitHubEventsClient,
  type PollerStore
} from "~/github/poller";

const account = {
  id: 1024,
  login: "octocat",
  etag: "old-etag",
  lastEventId: "old-event",
  consecutiveFailures: 4,
  pausedUntil: null
};

const createStore = () => {
  const calls = {
    insertedEvents: 0,
    successEtag: null as string | null,
    successLastEventId: null as string | null,
    notModifiedEtag: null as string | null,
    failurePausedUntil: undefined as Date | null | undefined
  };

  const store: PollerStore = {
    insertEvents: async (events) => {
      calls.insertedEvents += events.length;
    },
    markAccountPollSucceeded: async (input) => {
      calls.successEtag = input.etag;
      calls.successLastEventId = input.lastEventId;
    },
    markAccountPollNotModified: async (input) => {
      calls.notModifiedEtag = input.etag;
    },
    recordAccountPollFailure: async (input) => {
      calls.failurePausedUntil = input.pausedUntil;
    }
  };

  return { calls, store };
};

describe("GitHub poller", () => {
  test("stores events newer than the cursor and updates ETag", async () => {
    const { calls, store } = createStore();
    const client: GitHubEventsClient = {
      fetchUserEvents: async () => ({
        status: 200,
        headers: { etag: "new-etag" },
        data: [
          {
            id: "new-event",
            type: "PushEvent",
            repo: { name: "octocat/hello-world" },
            actor: { login: "octocat" },
            payload: { size: 1 },
            created_at: "2026-05-20T12:00:00Z"
          },
          {
            id: "old-event",
            type: "WatchEvent",
            repo: { name: "octocat/hello-world" },
            actor: { login: "octocat" },
            payload: {},
            created_at: "2026-05-20T11:00:00Z"
          }
        ]
      })
    };

    const result = await pollGitHubAccount(account, { client, store });

    expect(result.status).toBe("ok");
    expect(result.fetchedCount).toBe(2);
    expect(result.insertedCount).toBe(1);
    expect(calls.insertedEvents).toBe(1);
    expect(calls.successEtag).toBe("new-etag");
    expect(calls.successLastEventId).toBe("new-event");
  });

  test("marks not modified on GitHub 304 responses", async () => {
    const { calls, store } = createStore();
    const client: GitHubEventsClient = {
      fetchUserEvents: async () => {
        throw { status: 304, response: { headers: { etag: "same-etag" } } };
      }
    };

    const result = await pollGitHubAccount(account, { client, store });

    expect(result.status).toBe("not_modified");
    expect(result.insertedCount).toBe(0);
    expect(calls.notModifiedEtag).toBe("same-etag");
  });

  test("auto-pauses after five consecutive 404 failures", async () => {
    const { calls, store } = createStore();
    const now = new Date("2026-05-20T12:00:00Z");
    const client: GitHubEventsClient = {
      fetchUserEvents: async () => {
        throw { status: 404 };
      }
    };

    const result = await pollGitHubAccount(account, { client, store, now });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected poll to fail");
    }
    expect(result.failureStatus).toBe(404);
    expect(calls.failurePausedUntil?.toISOString()).toBe(
      "2026-05-21T12:00:00.000Z"
    );
  });
});
