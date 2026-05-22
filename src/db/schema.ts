// Defines the Drizzle schema for chats, accounts, events, subscriptions, and kv.
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const subscriptionPresetValues = [
  "firehose",
  "releases_only",
  "prs_and_releases",
  "code_activity",
  "new_stuff",
  "custom"
] as const;

export const schedulePresetValues = [
  "as_fetched",
  "hourly",
  "every_6h",
  "daily_09",
  "daily_18",
  "weekly_mon_09"
] as const;

export const chatTypeValues = [
  "private",
  "group",
  "supergroup",
  "channel"
] as const;

export const filterEventValues = [
  "push",
  "pull_request",
  "issues",
  "release",
  "repository",
  "fork",
  "star",
  "create"
] as const;

export type SubscriptionPreset = (typeof subscriptionPresetValues)[number];
export type SchedulePreset = (typeof schedulePresetValues)[number];
export type ChatType = (typeof chatTypeValues)[number];
export type FilterEvent = (typeof filterEventValues)[number];

export type SubscriptionFilters = {
  events: FilterEvent[];
  repos: {
    include: string[];
    exclude: string[];
  };
  ignoreBotAuthors: boolean;
  minCommitsPerPush: number;
  branches: {
    include: string[];
    exclude: string[];
  };
};

export type GitHubEventPayload = Record<string, unknown>;

const nowMs = sql`(unixepoch() * 1000)`;

export const githubAccounts = sqliteTable("github_accounts", {
  id: integer("id").primaryKey(),
  login: text("login").notNull().unique(),
  etag: text("etag"),
  lastPolledAt: integer("lastPolledAt", { mode: "timestamp_ms" }),
  lastEventId: text("lastEventId"),
  consecutiveFailures: integer("consecutiveFailures").notNull().default(0),
  pausedUntil: integer("pausedUntil", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs)
});

export const githubRepos = sqliteTable(
  "github_repos",
  {
    id: integer("id").primaryKey(),
    accountId: integer("accountId")
      .notNull()
      .references(() => githubAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    etag: text("etag"),
    lastEventId: text("lastEventId"),
    lastPolledAt: integer("lastPolledAt", { mode: "timestamp_ms" }),
    consecutiveFailures: integer("consecutiveFailures").notNull().default(0),
    pausedUntil: integer("pausedUntil", { mode: "timestamp_ms" }),
    createdAt: integer("createdAt", { mode: "timestamp_ms" })
      .notNull()
      .default(nowMs)
  },
  (table) => [
    uniqueIndex("github_repos_account_id_name_unique").on(
      table.accountId,
      table.name
    )
  ]
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    accountId: integer("accountId")
      .notNull()
      .references(() => githubAccounts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    repoName: text("repoName").notNull(),
    actorLogin: text("actorLogin").notNull(),
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<GitHubEventPayload>(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    ingestedAt: integer("ingestedAt", { mode: "timestamp_ms" })
      .notNull()
      .default(nowMs)
  },
  (table) => [
    index("events_account_id_created_at_idx").on(table.accountId, table.createdAt),
    index("events_type_idx").on(table.type)
  ]
);

export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey(),
  type: text("type", { enum: chatTypeValues }).notNull(),
  title: text("title"),
  addedByUserId: integer("addedByUserId"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  banned: integer("banned", { mode: "boolean" }).notNull().default(false),
  addedAt: integer("addedAt", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs),
  deactivatedAt: integer("deactivatedAt", { mode: "timestamp_ms" })
});

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chatId")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    accountId: integer("accountId")
      .notNull()
      .references(() => githubAccounts.id, { onDelete: "restrict" }),
    preset: text("preset", { enum: subscriptionPresetValues }).notNull(),
    filters: text("filters", { mode: "json" })
      .notNull()
      .$type<SubscriptionFilters>(),
    schedulePreset: text("schedulePreset", { enum: schedulePresetValues }).notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    lastDeliveredAt: integer("lastDeliveredAt", { mode: "timestamp_ms" }),
    selectedRepos: text("selectedRepos", { mode: "json" }).$type<string[] | null>(),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("createdAt", { mode: "timestamp_ms" })
      .notNull()
      .default(nowMs),
    createdByUserId: integer("createdByUserId").notNull()
  },
  (table) => [
    uniqueIndex("subscriptions_chat_id_account_id_unique").on(
      table.chatId,
      table.accountId
    )
  ]
);

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs)
});
