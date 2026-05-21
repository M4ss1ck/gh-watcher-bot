// Contains all database access functions used by the application.
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "~/db/client";
import {
  chats,
  events,
  githubAccounts,
  githubRepos,
  kv,
  subscriptions,
  type ChatType,
  type GitHubEventPayload,
  type SubscriptionFilters
} from "~/db/schema";
import type { SchedulePreset, SubscriptionPreset } from "~/db/schema";
import type { GitHubApiClient } from "~/github/client";
import type { GitHubUserSummary, StoredEvent } from "~/github/types";

export type UpsertChatInput = {
  id: number;
  type: ChatType;
  title: string | null;
  addedByUserId: number | null;
};

export type GitHubAccountForPolling = {
  id: number;
  login: string;
  etag: string | null;
  lastEventId: string | null;
  consecutiveFailures: number;
  pausedUntil: Date | null;
};

export type GitHubRepoForPolling = {
  id: number;
  accountId: number;
  ownerLogin: string;
  name: string;
  etag: string | null;
  lastEventId: string | null;
  consecutiveFailures: number;
  pausedUntil: Date | null;
};

export type SubscriptionRepoSelection = {
  selectedRepos: string[] | null;
};

export type UpsertGitHubAccountInput = {
  id: number;
  login: string;
};

export type UpsertGitHubRepoInput = {
  id: number;
  accountId: number;
  name: string;
};

export type StoredGitHubEventInput = {
  id: string;
  accountId: number;
  type: string;
  repoName: string;
  actorLogin: string;
  payload: GitHubEventPayload;
  createdAt: Date;
};

export type MarkGitHubAccountPollSucceededInput = {
  accountId: number;
  etag: string | null;
  lastEventId: string | null;
};

export type MarkGitHubAccountPollNotModifiedInput = {
  accountId: number;
  etag: string | null;
};

export type RecordGitHubAccountPollFailureInput = {
  accountId: number;
  consecutiveFailures: number;
  pausedUntil: Date | null;
};

export type MarkGitHubRepoPollSucceededInput = {
  repoId: number;
  etag: string | null;
  lastEventId: string | null;
};

export type MarkGitHubRepoPollNotModifiedInput = {
  repoId: number;
  etag: string | null;
};

export type RecordGitHubRepoPollFailureInput = {
  repoId: number;
  consecutiveFailures: number;
  pausedUntil: Date | null;
};

export type KvWriteInput = {
  key: string;
  value: string;
  updatedAt: Date;
};

export type CreateOrUpdateSubscriptionInput = {
  chatId: number;
  accountId: number;
  preset: SubscriptionPreset;
  filters: SubscriptionFilters;
  schedulePreset: SchedulePreset;
  timezone: string;
  selectedRepos?: string[] | null;
  createdByUserId: number;
  lastDeliveredAt?: Date | null;
};

export type SubscriptionListItem = {
  id: number;
  accountId: number;
  accountLogin: string;
  preset: SubscriptionPreset;
  schedulePreset: SchedulePreset;
  timezone: string;
  selectedRepos: string[] | null;
  paused: boolean;
  lastDeliveredAt: Date | null;
};

export type SubscriptionScheduleItem = {
  id: number;
  schedulePreset: SchedulePreset;
  timezone: string;
};

export type SubscriptionDeliveryRecord = {
  id: number;
  chatId: number;
  chatActive: boolean;
  chatBanned: boolean;
  accountId: number;
  accountLogin: string;
  filters: SubscriptionFilters;
  selectedRepos: string[] | null;
  lastDeliveredAt: Date | null;
};

export type AdminChatListItem = {
  id: number;
  type: ChatType;
  title: string | null;
  active: boolean;
  banned: boolean;
};

export type AdminAccountListItem = {
  id: number;
  login: string;
  lastPolledAt: Date | null;
  consecutiveFailures: number;
  pausedUntil: Date | null;
};

export type AdminSubscriptionListItem = {
  id: number;
  chatId: number;
  accountLogin: string;
  schedulePreset: SchedulePreset;
  paused: boolean;
};

export type AdminDiagnosticsCounts = {
  activeSubscriptions: number;
  activeChats: number;
  eventsIngestedLast24h: number;
};

const nowMs = sql`(unixepoch() * 1000)`;

export const getKvValue = async (key: string): Promise<string | null> => {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));

  return row?.value ?? null;
};

export const setKvValue = async (input: KvWriteInput): Promise<void> => {
  await db
    .insert(kv)
    .values({
      key: input.key,
      value: input.value,
      updatedAt: input.updatedAt
    })
    .onConflictDoUpdate({
      target: kv.key,
      set: {
        value: input.value,
        updatedAt: input.updatedAt
      }
    });
};

export const upsertChat = async (input: UpsertChatInput): Promise<void> => {
  await db
    .insert(chats)
    .values({
      id: input.id,
      type: input.type,
      title: input.title,
      addedByUserId: input.addedByUserId,
      active: true,
      banned: false,
      deactivatedAt: null
    })
    .onConflictDoUpdate({
      target: chats.id,
      set: {
        type: input.type,
        title: input.title,
        active: true,
        deactivatedAt: null
      }
    });
};

export const setChatActive = async (
  chatId: number,
  active: boolean
): Promise<void> => {
  await db
    .update(chats)
    .set({
      active,
      deactivatedAt: active ? null : nowMs
    })
    .where(eq(chats.id, chatId));
};

export const upsertGitHubAccount = async (
  input: UpsertGitHubAccountInput
): Promise<void> => {
  await db
    .insert(githubAccounts)
    .values({
      id: input.id,
      login: input.login
    })
    .onConflictDoUpdate({
      target: githubAccounts.id,
      set: {
        login: input.login,
        pausedUntil: null
      }
    });
};

export const upsertGitHubRepo = async (
  input: UpsertGitHubRepoInput
): Promise<void> => {
  await db
    .insert(githubRepos)
    .values({
      id: input.id,
      accountId: input.accountId,
      name: input.name
    })
    .onConflictDoUpdate({
      target: githubRepos.id,
      set: {
        accountId: input.accountId,
        name: input.name,
        pausedUntil: null
      }
    });
};

export const resolveOrCreateGitHubAccount = async (
  login: string,
  client: Pick<GitHubApiClient, "getUser">
): Promise<GitHubUserSummary> => {
  const user = await client.getUser(login);
  await upsertGitHubAccount({ id: user.id, login: user.login });

  return user;
};

export const resolveOrCreateGitHubRepo = async (input: {
  accountId: number;
  owner: string;
  repo: string;
  client: Pick<GitHubApiClient, "getRepo">;
}): Promise<{ id: number; name: string; fullName: string }> => {
  const repo = await input.client.getRepo(input.owner, input.repo);
  await upsertGitHubRepo({
    id: repo.id,
    accountId: input.accountId,
    name: repo.name
  });

  return repo;
};

export const getGitHubAccountByLogin = async (
  login: string
): Promise<GitHubAccountForPolling | null> => {
  const [row] = await db
    .select({
      id: githubAccounts.id,
      login: githubAccounts.login,
      etag: githubAccounts.etag,
      lastEventId: githubAccounts.lastEventId,
      consecutiveFailures: githubAccounts.consecutiveFailures,
      pausedUntil: githubAccounts.pausedUntil
    })
    .from(githubAccounts)
    .where(eq(githubAccounts.login, login));

  return row ?? null;
};

export const listGitHubAccountsForPolling = async (): Promise<
  GitHubAccountForPolling[]
> => {
  return db
    .select({
      id: githubAccounts.id,
      login: githubAccounts.login,
      etag: githubAccounts.etag,
      lastEventId: githubAccounts.lastEventId,
      consecutiveFailures: githubAccounts.consecutiveFailures,
      pausedUntil: githubAccounts.pausedUntil
    })
    .from(githubAccounts);
};

export const listActiveSubscriptionRepoSelectionsForAccount = async (
  accountId: number
): Promise<SubscriptionRepoSelection[]> => {
  return db
    .select({
      selectedRepos: subscriptions.selectedRepos
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.paused, false)));
};

export const listGitHubReposForPolling = async (
  accountId: number,
  names: string[]
): Promise<GitHubRepoForPolling[]> => {
  if (names.length === 0) {
    return [];
  }

  return db
    .select({
      id: githubRepos.id,
      accountId: githubRepos.accountId,
      ownerLogin: githubAccounts.login,
      name: githubRepos.name,
      etag: githubRepos.etag,
      lastEventId: githubRepos.lastEventId,
      consecutiveFailures: githubRepos.consecutiveFailures,
      pausedUntil: githubRepos.pausedUntil
    })
    .from(githubRepos)
    .innerJoin(githubAccounts, eq(githubRepos.accountId, githubAccounts.id))
    .where(and(eq(githubRepos.accountId, accountId), inArray(githubRepos.name, names)));
};

export const insertGitHubEvents = async (
  input: StoredGitHubEventInput[]
): Promise<void> => {
  if (input.length === 0) {
    return;
  }

  await db
    .insert(events)
    .values(
      input.map((event) => ({
        id: event.id,
        accountId: event.accountId,
        type: event.type,
        repoName: event.repoName,
        actorLogin: event.actorLogin,
        payload: event.payload,
        createdAt: event.createdAt
      }))
    )
    .onConflictDoNothing();
};

export const markGitHubAccountPollSucceeded = async (
  input: MarkGitHubAccountPollSucceededInput
): Promise<void> => {
  await db
    .update(githubAccounts)
    .set({
      etag: input.etag,
      lastEventId: input.lastEventId,
      lastPolledAt: nowMs,
      consecutiveFailures: 0,
      pausedUntil: null
    })
    .where(eq(githubAccounts.id, input.accountId));
};

export const markGitHubAccountPollNotModified = async (
  input: MarkGitHubAccountPollNotModifiedInput
): Promise<void> => {
  await db
    .update(githubAccounts)
    .set({
      etag: input.etag,
      lastPolledAt: nowMs,
      consecutiveFailures: 0
    })
    .where(eq(githubAccounts.id, input.accountId));
};

export const recordGitHubAccountPollFailure = async (
  input: RecordGitHubAccountPollFailureInput
): Promise<void> => {
  await db
    .update(githubAccounts)
    .set({
      lastPolledAt: nowMs,
      consecutiveFailures: input.consecutiveFailures,
      pausedUntil: input.pausedUntil
    })
    .where(eq(githubAccounts.id, input.accountId));
};

export const markGitHubRepoPollSucceeded = async (
  input: MarkGitHubRepoPollSucceededInput
): Promise<void> => {
  await db
    .update(githubRepos)
    .set({
      etag: input.etag,
      lastEventId: input.lastEventId,
      lastPolledAt: nowMs,
      consecutiveFailures: 0,
      pausedUntil: null
    })
    .where(eq(githubRepos.id, input.repoId));
};

export const markGitHubRepoPollNotModified = async (
  input: MarkGitHubRepoPollNotModifiedInput
): Promise<void> => {
  await db
    .update(githubRepos)
    .set({
      etag: input.etag,
      lastPolledAt: nowMs,
      consecutiveFailures: 0
    })
    .where(eq(githubRepos.id, input.repoId));
};

export const recordGitHubRepoPollFailure = async (
  input: RecordGitHubRepoPollFailureInput
): Promise<void> => {
  await db
    .update(githubRepos)
    .set({
      lastPolledAt: nowMs,
      consecutiveFailures: input.consecutiveFailures,
      pausedUntil: input.pausedUntil
    })
    .where(eq(githubRepos.id, input.repoId));
};

export const countEventsForAccount = async (accountId: number): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.accountId, accountId));

  return row?.count ?? 0;
};

export const listSubscriptionsForChat = async (
  chatId: number
): Promise<SubscriptionListItem[]> => {
  return db
    .select({
      id: subscriptions.id,
      accountId: githubAccounts.id,
      accountLogin: githubAccounts.login,
      preset: subscriptions.preset,
      schedulePreset: subscriptions.schedulePreset,
      timezone: subscriptions.timezone,
      selectedRepos: subscriptions.selectedRepos,
      paused: subscriptions.paused,
      lastDeliveredAt: subscriptions.lastDeliveredAt
    })
    .from(subscriptions)
    .innerJoin(githubAccounts, eq(subscriptions.accountId, githubAccounts.id))
    .where(eq(subscriptions.chatId, chatId));
};

export const createOrUpdateSubscription = async (
  input: CreateOrUpdateSubscriptionInput
): Promise<number> => {
  const [row] = await db
    .insert(subscriptions)
    .values({
      chatId: input.chatId,
      accountId: input.accountId,
      preset: input.preset,
      filters: input.filters,
      schedulePreset: input.schedulePreset,
      timezone: input.timezone,
      selectedRepos: input.selectedRepos ?? null,
      paused: false,
      createdByUserId: input.createdByUserId,
      lastDeliveredAt: input.lastDeliveredAt ?? null
    })
    .onConflictDoUpdate({
      target: [subscriptions.chatId, subscriptions.accountId],
      set: {
        preset: input.preset,
        filters: input.filters,
        schedulePreset: input.schedulePreset,
        timezone: input.timezone,
        selectedRepos: input.selectedRepos ?? null,
        paused: false
      }
    })
    .returning({ id: subscriptions.id });

  if (row === undefined) {
    throw new Error("subscription upsert did not return an id");
  }

  return row.id;
};

export const deleteSubscription = async (id: number): Promise<void> => {
  await db.delete(subscriptions).where(eq(subscriptions.id, id));
};

export const setSubscriptionPaused = async (
  id: number,
  paused: boolean
): Promise<void> => {
  await db
    .update(subscriptions)
    .set({ paused })
    .where(eq(subscriptions.id, id));
};

export const countSubscriptionsForChat = async (
  chatId: number
): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(subscriptions)
    .where(eq(subscriptions.chatId, chatId));

  return row?.count ?? 0;
};

export const updateSubscriptionFilters = async (
  id: number,
  filters: SubscriptionFilters,
  preset: SubscriptionPreset
): Promise<void> => {
  await db
    .update(subscriptions)
    .set({ filters, preset })
    .where(eq(subscriptions.id, id));
};

export const updateSubscriptionSchedule = async (
  id: number,
  schedulePreset: SchedulePreset,
  timezone: string
): Promise<void> => {
  await db
    .update(subscriptions)
    .set({ schedulePreset, timezone })
    .where(eq(subscriptions.id, id));
};

export const updateSubscriptionSelectedRepos = async (
  id: number,
  selectedRepos: string[] | null
): Promise<void> => {
  await db
    .update(subscriptions)
    .set({ selectedRepos })
    .where(eq(subscriptions.id, id));
};

export const listActiveSubscriptionSchedules = async (): Promise<
  SubscriptionScheduleItem[]
> => {
  return db
    .select({
      id: subscriptions.id,
      schedulePreset: subscriptions.schedulePreset,
      timezone: subscriptions.timezone
    })
    .from(subscriptions)
    .where(eq(subscriptions.paused, false));
};

export const getSubscriptionForDelivery = async (
  subscriptionId: number
): Promise<SubscriptionDeliveryRecord | null> => {
  const [row] = await db
    .select({
      id: subscriptions.id,
      chatId: subscriptions.chatId,
      chatActive: chats.active,
      chatBanned: chats.banned,
      accountId: subscriptions.accountId,
      accountLogin: githubAccounts.login,
      filters: subscriptions.filters,
      selectedRepos: subscriptions.selectedRepos,
      lastDeliveredAt: subscriptions.lastDeliveredAt
    })
    .from(subscriptions)
    .innerJoin(chats, eq(subscriptions.chatId, chats.id))
    .innerJoin(githubAccounts, eq(subscriptions.accountId, githubAccounts.id))
    .where(eq(subscriptions.id, subscriptionId));

  return row ?? null;
};

export const listEventsForDelivery = async (
  accountId: number,
  lastDeliveredAt: Date | null
): Promise<StoredEvent[]> => {
  const whereClause =
    lastDeliveredAt === null
      ? eq(events.accountId, accountId)
      : and(eq(events.accountId, accountId), gt(events.createdAt, lastDeliveredAt));

  return db
    .select({
      id: events.id,
      accountId: events.accountId,
      type: events.type,
      repoName: events.repoName,
      actorLogin: events.actorLogin,
      payload: events.payload,
      createdAt: events.createdAt
    })
    .from(events)
    .where(whereClause)
    .orderBy(asc(events.createdAt));
};

export const updateSubscriptionDeliveryCursor = async (
  subscriptionId: number,
  deliveredAt: Date
): Promise<void> => {
  await db
    .update(subscriptions)
    .set({
      lastDeliveredAt: deliveredAt
    })
    .where(eq(subscriptions.id, subscriptionId));
};

export const countActiveSubscriptions = async (): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(subscriptions)
    .where(eq(subscriptions.paused, false));

  return row?.count ?? 0;
};

export const countActiveChats = async (): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(chats)
    .where(and(eq(chats.active, true), eq(chats.banned, false)));

  return row?.count ?? 0;
};

export const countEventsIngestedSince = async (since: Date): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(gt(events.ingestedAt, since));

  return row?.count ?? 0;
};

export const getAdminDiagnosticsCounts = async (
  now = new Date()
): Promise<AdminDiagnosticsCounts> => {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [activeSubscriptions, activeChats, eventsIngestedLast24h] =
    await Promise.all([
      countActiveSubscriptions(),
      countActiveChats(),
      countEventsIngestedSince(dayAgo)
    ]);

  return {
    activeSubscriptions,
    activeChats,
    eventsIngestedLast24h
  };
};

export const listAdminChats = async (
  limit = 20,
  offset = 0
): Promise<AdminChatListItem[]> => {
  return db
    .select({
      id: chats.id,
      type: chats.type,
      title: chats.title,
      active: chats.active,
      banned: chats.banned
    })
    .from(chats)
    .orderBy(desc(chats.addedAt))
    .limit(limit)
    .offset(offset);
};

export const listActiveChatIds = async (): Promise<number[]> => {
  const rows = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.active, true), eq(chats.banned, false)));

  return rows.map((row) => row.id);
};

export const listAdminAccounts = async (
  limit = 20,
  offset = 0
): Promise<AdminAccountListItem[]> => {
  return db
    .select({
      id: githubAccounts.id,
      login: githubAccounts.login,
      lastPolledAt: githubAccounts.lastPolledAt,
      consecutiveFailures: githubAccounts.consecutiveFailures,
      pausedUntil: githubAccounts.pausedUntil
    })
    .from(githubAccounts)
    .orderBy(asc(githubAccounts.login))
    .limit(limit)
    .offset(offset);
};

export const getGitHubAccountById = async (
  accountId: number
): Promise<GitHubAccountForPolling | null> => {
  const [row] = await db
    .select({
      id: githubAccounts.id,
      login: githubAccounts.login,
      etag: githubAccounts.etag,
      lastEventId: githubAccounts.lastEventId,
      consecutiveFailures: githubAccounts.consecutiveFailures,
      pausedUntil: githubAccounts.pausedUntil
    })
    .from(githubAccounts)
    .where(eq(githubAccounts.id, accountId));

  return row ?? null;
};

export const listAdminSubscriptions = async (
  limit = 20,
  offset = 0
): Promise<AdminSubscriptionListItem[]> => {
  return db
    .select({
      id: subscriptions.id,
      chatId: subscriptions.chatId,
      accountLogin: githubAccounts.login,
      schedulePreset: subscriptions.schedulePreset,
      paused: subscriptions.paused
    })
    .from(subscriptions)
    .innerJoin(githubAccounts, eq(subscriptions.accountId, githubAccounts.id))
    .orderBy(desc(subscriptions.createdAt))
    .limit(limit)
    .offset(offset);
};
