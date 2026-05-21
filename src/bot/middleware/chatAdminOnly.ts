// Checks chat administrator permissions before chat-scoped mutations.
import type { Api, Context, MiddlewareFn } from "grammy";

import { isAdminUserId } from "~/bot/middleware/adminOnly";

type CacheEntry = {
  admins: Set<number>;
  expiresAt: number;
};

const cacheTtlMs = 60_000;
const cache = new Map<number, CacheEntry>();

const loadChatAdminIds = async (
  api: Api,
  chatId: number,
  nowMs = Date.now()
): Promise<Set<number>> => {
  const cached = cache.get(chatId);

  if (cached !== undefined && cached.expiresAt > nowMs) {
    return cached.admins;
  }

  const members = await api.getChatAdministrators(chatId);
  const admins = new Set(members.map((member) => member.user.id));
  cache.set(chatId, { admins, expiresAt: nowMs + cacheTtlMs });

  return admins;
};

export const isUserChatAdmin = async (
  api: Api,
  chatId: number,
  userId: number,
  nowMs = Date.now()
): Promise<boolean> => {
  const admins = await loadChatAdminIds(api, chatId, nowMs);
  return admins.has(userId);
};

export const clearChatAdminCache = (chatId?: number): void => {
  if (chatId === undefined) {
    cache.clear();
    return;
  }

  cache.delete(chatId);
};

export const chatAdminOnly: MiddlewareFn<Context> = async (ctx, next) => {
  if (isAdminUserId(ctx.from?.id)) {
    await next();
    return;
  }

  if (ctx.chat === undefined || ctx.from === undefined) {
    await ctx.reply("Open this from a chat.");
    return;
  }

  if (ctx.chat.type === "private") {
    await next();
    return;
  }

  const allowed = await isUserChatAdmin(ctx.api, ctx.chat.id, ctx.from.id);

  if (!allowed) {
    await ctx.reply("Only chat admins can change subscriptions.");
    return;
  }

  await next();
};
