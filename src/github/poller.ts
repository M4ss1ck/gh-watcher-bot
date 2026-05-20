// Polls public GitHub user events with ETag and cursor handling.
import type {
  GitHubAccountForPolling,
  MarkGitHubAccountPollNotModifiedInput,
  MarkGitHubAccountPollSucceededInput,
  RecordGitHubAccountPollFailureInput,
  StoredGitHubEventInput
} from "~/db/queries";
import type { GitHubEventsResponse } from "~/github/client";
import type { GitHubPublicEvent } from "~/github/types";

const dayMs = 24 * 60 * 60 * 1000;

export type GitHubEventsClient = {
  fetchUserEvents: (input: {
    login: string;
    etag: string | null;
  }) => Promise<GitHubEventsResponse>;
};

export type PollerStore = {
  insertEvents: (events: StoredGitHubEventInput[]) => Promise<void>;
  markAccountPollSucceeded: (
    input: MarkGitHubAccountPollSucceededInput
  ) => Promise<void>;
  markAccountPollNotModified: (
    input: MarkGitHubAccountPollNotModifiedInput
  ) => Promise<void>;
  recordAccountPollFailure: (
    input: RecordGitHubAccountPollFailureInput
  ) => Promise<void>;
};

export type PollResult =
  | {
      status: "ok";
      accountId: number;
      login: string;
      fetchedCount: number;
      insertedCount: number;
      etag: string | null;
      lastEventId: string | null;
    }
  | {
      status: "not_modified";
      accountId: number;
      login: string;
      fetchedCount: 0;
      insertedCount: 0;
      etag: string | null;
    }
  | {
      status: "skipped_paused";
      accountId: number;
      login: string;
      fetchedCount: 0;
      insertedCount: 0;
      pausedUntil: Date;
    }
  | {
      status: "failed";
      accountId: number;
      login: string;
      fetchedCount: 0;
      insertedCount: 0;
      consecutiveFailures: number;
      pausedUntil: Date | null;
      failureStatus: number | null;
    };

export type PollGitHubAccountOptions = {
  client: GitHubEventsClient;
  store?: PollerStore;
  now?: Date;
};

const defaultStore: PollerStore = {
  insertEvents: async (events) => {
    const queries = await import("~/db/queries");
    await queries.insertGitHubEvents(events);
  },
  markAccountPollSucceeded: async (input) => {
    const queries = await import("~/db/queries");
    await queries.markGitHubAccountPollSucceeded(input);
  },
  markAccountPollNotModified: async (input) => {
    const queries = await import("~/db/queries");
    await queries.markGitHubAccountPollNotModified(input);
  },
  recordAccountPollFailure: async (input) => {
    const queries = await import("~/db/queries");
    await queries.recordGitHubAccountPollFailure(input);
  }
};

const getHeaderEtag = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return null;
  }

  const response = error.response;

  if (
    typeof response !== "object" ||
    response === null ||
    !("headers" in response)
  ) {
    return null;
  }

  const headers = response.headers;

  if (typeof headers !== "object" || headers === null || !("etag" in headers)) {
    return null;
  }

  return typeof headers.etag === "string" ? headers.etag : null;
};

const getErrorStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }

  return typeof error.status === "number" ? error.status : null;
};

const toStoredEvent = (
  accountId: number,
  event: GitHubPublicEvent
): StoredGitHubEventInput | null => {
  const createdAt = new Date(event.created_at);

  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return {
    id: event.id,
    accountId,
    type: event.type,
    repoName: event.repo.name,
    actorLogin: event.actor.login,
    payload: event.payload,
    createdAt
  };
};

const getEventsNewerThanCursor = (
  events: GitHubPublicEvent[],
  lastEventId: string | null
): GitHubPublicEvent[] => {
  if (lastEventId === null) {
    return events;
  }

  const cursorIndex = events.findIndex((event) => event.id === lastEventId);

  return cursorIndex === -1 ? events : events.slice(0, cursorIndex);
};

export const pollGitHubAccount = async (
  account: GitHubAccountForPolling,
  options: PollGitHubAccountOptions
): Promise<PollResult> => {
  const now = options.now ?? new Date();
  const store = options.store ?? defaultStore;

  if (account.pausedUntil !== null && account.pausedUntil > now) {
    return {
      status: "skipped_paused",
      accountId: account.id,
      login: account.login,
      fetchedCount: 0,
      insertedCount: 0,
      pausedUntil: account.pausedUntil
    };
  }

  try {
    const response = await options.client.fetchUserEvents({
      login: account.login,
      etag: account.etag
    });
    const etag = response.headers.etag ?? account.etag;
    const newestEventId = response.data[0]?.id ?? account.lastEventId;
    const newEvents = getEventsNewerThanCursor(response.data, account.lastEventId)
      .map((event) => toStoredEvent(account.id, event))
      .filter((event): event is StoredGitHubEventInput => event !== null);

    await store.insertEvents(newEvents);
    await store.markAccountPollSucceeded({
      accountId: account.id,
      etag,
      lastEventId: newestEventId
    });

    return {
      status: "ok",
      accountId: account.id,
      login: account.login,
      fetchedCount: response.data.length,
      insertedCount: newEvents.length,
      etag,
      lastEventId: newestEventId
    };
  } catch (error) {
    const failureStatus = getErrorStatus(error);

    if (failureStatus === 304) {
      const etag = getHeaderEtag(error) ?? account.etag;

      await store.markAccountPollNotModified({
        accountId: account.id,
        etag
      });

      return {
        status: "not_modified",
        accountId: account.id,
        login: account.login,
        fetchedCount: 0,
        insertedCount: 0,
        etag
      };
    }

    const consecutiveFailures = account.consecutiveFailures + 1;
    const pausedUntil =
      failureStatus === 404 && consecutiveFailures >= 5
        ? new Date(now.getTime() + dayMs)
        : null;

    await store.recordAccountPollFailure({
      accountId: account.id,
      consecutiveFailures,
      pausedUntil
    });

    return {
      status: "failed",
      accountId: account.id,
      login: account.login,
      fetchedCount: 0,
      insertedCount: 0,
      consecutiveFailures,
      pausedUntil,
      failureStatus
    };
  }
};
