// Contains all database access functions used by the application.
import { eq, sql } from "drizzle-orm";

import { db } from "~/db/client";
import {
  chats,
  events,
  githubAccounts,
  kv,
  type ChatType,
  type GitHubEventPayload
} from "~/db/schema";

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

export type UpsertGitHubAccountInput = {
  id: number;
  login: string;
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

const nowMs = sql`(unixepoch() * 1000)`;

export const getKvValue = async (key: string): Promise<string | null> => {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));

  return row?.value ?? null;
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

export const countEventsForAccount = async (accountId: number): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.accountId, accountId));

  return row?.count ?? 0;
};
