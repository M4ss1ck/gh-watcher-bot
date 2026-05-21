// Verifies the database schema exports the required v1 tables.
import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import {
  chats,
  events,
  githubAccounts,
  githubRepos,
  kv,
  subscriptions
} from "~/db/schema";

describe("database schema", () => {
  test("defines the required table names", () => {
    expect(getTableName(githubAccounts)).toBe("github_accounts");
    expect(getTableName(githubRepos)).toBe("github_repos");
    expect(getTableName(events)).toBe("events");
    expect(getTableName(chats)).toBe("chats");
    expect(getTableName(subscriptions)).toBe("subscriptions");
    expect(getTableName(kv)).toBe("kv");
  });

  test("defines required columns and indexes", () => {
    expect(Object.keys(githubAccounts)).toEqual([
      "id",
      "login",
      "etag",
      "lastPolledAt",
      "lastEventId",
      "consecutiveFailures",
      "pausedUntil",
      "createdAt"
    ]);

    expect(Object.keys(githubRepos)).toEqual([
      "id",
      "accountId",
      "name",
      "etag",
      "lastEventId",
      "lastPolledAt",
      "consecutiveFailures",
      "pausedUntil",
      "createdAt"
    ]);

    expect(Object.keys(events)).toEqual([
      "id",
      "accountId",
      "type",
      "repoName",
      "actorLogin",
      "payload",
      "createdAt",
      "ingestedAt"
    ]);

    expect(Object.keys(chats)).toEqual([
      "id",
      "type",
      "title",
      "addedByUserId",
      "active",
      "banned",
      "addedAt",
      "deactivatedAt"
    ]);

    expect(Object.keys(subscriptions)).toEqual([
      "id",
      "chatId",
      "accountId",
      "preset",
      "filters",
      "schedulePreset",
      "timezone",
      "lastDeliveredAt",
      "selectedRepos",
      "paused",
      "createdAt",
      "createdByUserId"
    ]);

    expect(Object.keys(kv)).toEqual(["key", "value", "updatedAt"]);
  });
});
