// Handles admin command menu entry for configured administrators.
import { Menu, MenuRange } from "@grammyjs/menu";
import type { Bot, Context, NextFunction } from "grammy";

import {
  adminAccountsMenuId,
  adminBroadcastConfirmMenuId,
  adminChatsMenuId,
  adminDiagnosticsMenuId,
  adminForceDeliverMenuId,
  adminForcePollMenuId,
  adminMenuId
} from "~/bot/menus/ids";
import { adminOnly, isAdminUserId } from "~/bot/middleware/adminOnly";
import type {
  AdminAccountListItem,
  AdminChatListItem,
  AdminSubscriptionListItem
} from "~/db/queries";
import { formatSchedulePresetLabel } from "~/formatting/labels";
import { escapeHtml } from "~/formatting/render";
import { createGitHubClient, getGitHubRateLimitRemaining } from "~/github/client";
import { pollGitHubAccount } from "~/github/poller";
import { logger } from "~/lib/logger";
import { getMetricsSnapshot, type MetricsSnapshot } from "~/lib/metrics";
import { runDeliveryTask } from "~/scheduler/deliverer";

export { isAdminUserId };

export type AdminDiagnosticsInput = {
  lastCollectorTickAge: string;
  githubRateLimitRemaining: string;
  activeSubscriptions: number;
  activeChats: number;
  eventsIngestedLast24h: number;
  errorsLast24h: number;
  metrics?: Pick<
    MetricsSnapshot,
    "githubApiRequestsTotal" | "deliveriesSentTotal" | "telegramApiErrorsTotal" | "aiSummariesTotal"
  >;
};

type AdminTextInput = {
  waitingFor: "broadcast";
};

type AdminTextInputKey = {
  chatId: number;
  userId: number;
};

type AdminBroadcastDraft = {
  text: string;
};

const adminInputTtlMs = 60_000;
const adminTextInputs = new Map<string, AdminTextInput & { expiresAt: number }>();
const broadcastDrafts = new Map<string, AdminBroadcastDraft>();

const keyFromParts = (key: AdminTextInputKey): string => `${key.chatId}:${key.userId}`;

export const buildAdminMenuText = (): string => "Admin";

export const formatAdminChatButton = (
  item: Pick<AdminChatListItem, "id" | "type" | "title">
): string => `${item.title ?? item.type} ${item.id}`;

export const formatAdminAccountButton = (
  item: Pick<AdminAccountListItem, "login">
): string => `@${item.login}`;

export const formatAdminSubscriptionButton = (
  item: Pick<
    AdminSubscriptionListItem,
    "id" | "accountLogin" | "schedulePreset"
  >
): string =>
  `#${item.id} @${item.accountLogin} ${formatSchedulePresetLabel(item.schedulePreset)}`;

export const buildBroadcastConfirmationText = (
  text: string,
  activeChatCount: number
): string => {
  const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;

  return `Broadcast to ${activeChatCount} active chats?\n\n${preview}`;
};

export const buildAdminDiagnosticsMessage = (
  input: AdminDiagnosticsInput
): string => {
  const githubRequests = input.metrics?.githubApiRequestsTotal;
  const deliveries = input.metrics?.deliveriesSentTotal;
  const telegramErrors = input.metrics?.telegramApiErrorsTotal;
  const aiSummaries = input.metrics?.aiSummariesTotal;
  const telegramErrorCount = Object.values(telegramErrors ?? {}).reduce(
    (sum, value) => sum + value,
    0
  );

  return [
    "Diagnostics",
    `Collector tick: ${input.lastCollectorTickAge}`,
    `GitHub rate limit remaining: ${input.githubRateLimitRemaining}`,
    `Active subscriptions: ${input.activeSubscriptions}`,
    `Active chats: ${input.activeChats}`,
    `Events ingested in last 24h: ${input.eventsIngestedLast24h}`,
    `Errors in last 24h: ${input.errorsLast24h}`,
    githubRequests === undefined
      ? null
      : `GitHub requests: 200=${githubRequests["200"]}, 304=${githubRequests["304"]}, 4xx=${githubRequests["4xx"]}, 5xx=${githubRequests["5xx"]}, error=${githubRequests.error}`,
    deliveries === undefined
      ? null
      : `Deliveries: ok=${deliveries.ok}, empty=${deliveries.empty}, error=${deliveries.error}`,
    aiSummaries === undefined
      ? null
      : `AI summaries: ok=${aiSummaries.ok}, error=${aiSummaries.error}`,
    telegramErrors === undefined
      ? null
      : `Telegram API errors: ${telegramErrorCount}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

const adminTextKeyFromContext = (ctx: Context): AdminTextInputKey | null => {
  if (ctx.chat === undefined || ctx.from === undefined) {
    return null;
  }

  return {
    chatId: ctx.chat.id,
    userId: ctx.from.id
  };
};

const setAdminTextInput = (
  key: AdminTextInputKey,
  input: AdminTextInput,
  nowMs = Date.now()
): void => {
  adminTextInputs.set(keyFromParts(key), {
    ...input,
    expiresAt: nowMs + adminInputTtlMs
  });
};

const takeAdminTextInput = (
  key: AdminTextInputKey,
  nowMs = Date.now()
): AdminTextInput | null => {
  const mapKey = keyFromParts(key);
  const input = adminTextInputs.get(mapKey);

  if (input === undefined) {
    return null;
  }

  adminTextInputs.delete(mapKey);

  if (input.expiresAt <= nowMs) {
    return null;
  }

  return {
    waitingFor: input.waitingFor
  };
};

const setBroadcastDraft = (key: AdminTextInputKey, text: string): void => {
  broadcastDrafts.set(keyFromParts(key), { text });
};

const adminPageSize = 20;
const paginationOffsets = new Map<string, number>();

const paginationKey = (menu: string, userId: number | undefined): string =>
  `${menu}:${userId ?? 0}`;

const getOffset = (menu: string, userId: number | undefined): number =>
  paginationOffsets.get(paginationKey(menu, userId)) ?? 0;

const setOffset = (
  menu: string,
  userId: number | undefined,
  offset: number
): void => {
  paginationOffsets.set(paginationKey(menu, userId), Math.max(0, offset));
};

const addPaginationControls = (
  range: MenuRange<Context>,
  menu: string,
  offset: number,
  hasMore: boolean
): void => {
  const hasPrev = offset > 0;

  if (!hasPrev && !hasMore) {
    return;
  }

  if (hasPrev) {
    range.text("◀️ Prev", async (ctx) => {
      if (!(await answerAdminOnlyCallback(ctx))) {
        return;
      }

      setOffset(menu, ctx.from?.id, offset - adminPageSize);
      ctx.menu.update();
    });
  }

  if (hasMore) {
    range.text("Next ▶️", async (ctx) => {
      if (!(await answerAdminOnlyCallback(ctx))) {
        return;
      }

      setOffset(menu, ctx.from?.id, offset + adminPageSize);
      ctx.menu.update();
    });
  }

  range.row();
};

const takeBroadcastDraft = (key: AdminTextInputKey): AdminBroadcastDraft | null => {
  const mapKey = keyFromParts(key);
  const draft = broadcastDrafts.get(mapKey);

  if (draft === undefined) {
    return null;
  }

  broadcastDrafts.delete(mapKey);

  return draft;
};

const getActiveChatCount = async (): Promise<number> => {
  const queries = await import("~/db/queries");

  return queries.countActiveChats();
};

export const loadAdminDiagnosticsInput = async (): Promise<AdminDiagnosticsInput> => {
  const [{ formatCollectorTickAge, readCollectorLastTickMs }, queries] =
    await Promise.all([import("~/bot/commands/ping"), import("~/db/queries")]);
  const [lastTickMs, counts] = await Promise.all([
    readCollectorLastTickMs(),
    queries.getAdminDiagnosticsCounts()
  ]);
  const metrics = getMetricsSnapshot();
  const errorsLast24h =
    metrics.githubApiRequestsTotal.error +
    metrics.deliveriesSentTotal.error +
    Object.values(metrics.telegramApiErrorsTotal).reduce(
      (sum, value) => sum + value,
      0
    );

  const remaining = getGitHubRateLimitRemaining();

  return {
    lastCollectorTickAge: formatCollectorTickAge(lastTickMs),
    githubRateLimitRemaining: remaining === null ? "unknown" : String(remaining),
    activeSubscriptions: counts.activeSubscriptions,
    activeChats: counts.activeChats,
    eventsIngestedLast24h: counts.eventsIngestedLast24h,
    errorsLast24h,
    metrics
  };
};

const answerAdminOnlyCallback = async (ctx: Context): Promise<boolean> => {
  if (isAdminUserId(ctx.from?.id)) {
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Admin only." });
  return false;
};

const handleAdminTextInput = async (
  ctx: Context,
  next: NextFunction
): Promise<void> => {
  if (ctx.message?.text === undefined || ctx.chat === undefined || ctx.from === undefined) {
    await next();
    return;
  }

  if (!isAdminUserId(ctx.from.id) || ctx.message.text.startsWith("/")) {
    await next();
    return;
  }

  const key = {
    chatId: ctx.chat.id,
    userId: ctx.from.id
  };
  const input = takeAdminTextInput(key);

  if (input === null) {
    await next();
    return;
  }

  setBroadcastDraft(key, ctx.message.text);
  await ctx.reply(
    buildBroadcastConfirmationText(ctx.message.text, await getActiveChatCount()),
    {
      reply_markup: adminBroadcastConfirmMenu
    }
  );
};

const sendBroadcast = async (ctx: Context, text: string): Promise<number> => {
  const queries = await import("~/db/queries");
  const chatIds = await queries.listActiveChatIds();
  let sentCount = 0;

  for (const chatId of chatIds) {
    try {
      await ctx.api.sendMessage(chatId, text);
      sentCount += 1;
    } catch (error) {
      logger.error({ err: error, chat_id: chatId }, "broadcast send failed");
    }
  }

  return sentCount;
};

export const adminMenu = new Menu<Context>(adminMenuId)
  .submenu("💬 Chats", adminChatsMenuId, async (ctx) => {
    if (await answerAdminOnlyCallback(ctx)) {
      await ctx.editMessageText("Chats");
    }
  })
  .submenu("👤 Accounts", adminAccountsMenuId, async (ctx) => {
    if (await answerAdminOnlyCallback(ctx)) {
      await ctx.editMessageText("Accounts");
    }
  })
  .text("📣 Broadcast", async (ctx) => {
    if (!(await answerAdminOnlyCallback(ctx))) {
      return;
    }

    const key = adminTextKeyFromContext(ctx);

    if (key === null) {
      await ctx.answerCallbackQuery({ text: "Open this from a chat." });
      return;
    }

    setAdminTextInput(key, { waitingFor: "broadcast" });
    await ctx.reply("Send the broadcast text within 60 seconds.");
  })
  .row()
  .submenu("🧪 Diagnostics", adminDiagnosticsMenuId, async (ctx) => {
    if (await answerAdminOnlyCallback(ctx)) {
      await ctx.editMessageText(
        buildAdminDiagnosticsMessage(await loadAdminDiagnosticsInput())
      );
    }
  })
  .submenu("🔄 Force-poll", adminForcePollMenuId, async (ctx) => {
    if (await answerAdminOnlyCallback(ctx)) {
      await ctx.editMessageText("Force-poll");
    }
  })
  .submenu("🚚 Force-deliver", adminForceDeliverMenuId, async (ctx) => {
    if (await answerAdminOnlyCallback(ctx)) {
      await ctx.editMessageText("Force-deliver");
    }
  });

export const adminChatsMenu = new Menu<Context>(adminChatsMenuId)
  .dynamic(async (ctx, range) => {
    const queries = await import("~/db/queries");
    const offset = getOffset("chats", ctx.from?.id);
    const fetched = await queries.listAdminChats(adminPageSize + 1, offset);
    const visible = fetched.slice(0, adminPageSize);
    const hasMore = fetched.length > adminPageSize;

    for (const chat of visible) {
      range.text(formatAdminChatButton(chat), async (callbackCtx) => {
        if (!(await answerAdminOnlyCallback(callbackCtx))) {
          return;
        }

        await callbackCtx.answerCallbackQuery({
          text: chat.active && !chat.banned ? "active" : "inactive"
        });
      }).row();
    }

    addPaginationControls(range, "chats", offset, hasMore);

    return range;
  })
  .back("◀️ Back", async (ctx) => {
    await ctx.editMessageText(buildAdminMenuText());
  });

export const adminAccountsMenu = new Menu<Context>(adminAccountsMenuId)
  .dynamic(async (ctx, range) => {
    const queries = await import("~/db/queries");
    const offset = getOffset("accounts", ctx.from?.id);
    const fetched = await queries.listAdminAccounts(adminPageSize + 1, offset);
    const visible = fetched.slice(0, adminPageSize);
    const hasMore = fetched.length > adminPageSize;

    for (const account of visible) {
      range.text(formatAdminAccountButton(account), async (callbackCtx) => {
        if (!(await answerAdminOnlyCallback(callbackCtx))) {
          return;
        }

        await callbackCtx.answerCallbackQuery({
          text: `failures ${account.consecutiveFailures}`
        });
      }).row();
    }

    addPaginationControls(range, "accounts", offset, hasMore);

    return range;
  })
  .back("◀️ Back", async (ctx) => {
    await ctx.editMessageText(buildAdminMenuText());
  });

export const adminDiagnosticsMenu = new Menu<Context>(adminDiagnosticsMenuId)
  .text("🔄 Refresh", async (ctx) => {
    if (await answerAdminOnlyCallback(ctx)) {
      await ctx.editMessageText(
        buildAdminDiagnosticsMessage(await loadAdminDiagnosticsInput())
      );
    }
  })
  .row()
  .back("◀️ Back", async (ctx) => {
    await ctx.editMessageText(buildAdminMenuText());
  });

export const adminForcePollMenu = new Menu<Context>(adminForcePollMenuId)
  .dynamic(async (ctx, range) => {
    const queries = await import("~/db/queries");
    const offset = getOffset("force-poll", ctx.from?.id);
    const fetched = await queries.listAdminAccounts(adminPageSize + 1, offset);
    const visible = fetched.slice(0, adminPageSize);
    const hasMore = fetched.length > adminPageSize;

    for (const account of visible) {
      range.text(formatAdminAccountButton(account), async (callbackCtx) => {
        if (!(await answerAdminOnlyCallback(callbackCtx))) {
          return;
        }

        const pollAccount = await queries.getGitHubAccountById(account.id);

        if (pollAccount === null) {
          await callbackCtx.answerCallbackQuery({ text: "Account missing." });
          return;
        }

        const result = await pollGitHubAccount(pollAccount, {
          client: createGitHubClient()
        });

        await callbackCtx.reply(
          `Force-poll <code>@${escapeHtml(result.login)}</code>: ${result.status}, inserted ${result.insertedCount}`
        );
      }).row();
    }

    addPaginationControls(range, "force-poll", offset, hasMore);

    return range;
  })
  .back("◀️ Back", async (ctx) => {
    await ctx.editMessageText(buildAdminMenuText());
  });

export const adminForceDeliverMenu = new Menu<Context>(adminForceDeliverMenuId)
  .dynamic(async (ctx, range) => {
    const queries = await import("~/db/queries");
    const offset = getOffset("force-deliver", ctx.from?.id);
    const fetched = await queries.listAdminSubscriptions(adminPageSize + 1, offset);
    const visible = fetched.slice(0, adminPageSize);
    const hasMore = fetched.length > adminPageSize;

    for (const subscription of visible) {
      range.text(formatAdminSubscriptionButton(subscription), async (callbackCtx) => {
        if (!(await answerAdminOnlyCallback(callbackCtx))) {
          return;
        }

        const result = await runDeliveryTask({
          subscriptionId: subscription.id,
          sendMessage: async (chatId, text) => {
            await callbackCtx.api.sendMessage(chatId, text);
          }
        });

        await callbackCtx.reply(
          `Force-deliver #${subscription.id}: ${result.status}, events ${result.eventCount}`
        );
      }).row();
    }

    addPaginationControls(range, "force-deliver", offset, hasMore);

    return range;
  })
  .back("◀️ Back", async (ctx) => {
    await ctx.editMessageText(buildAdminMenuText());
  });

export const adminBroadcastConfirmMenu = new Menu<Context>(
  adminBroadcastConfirmMenuId
)
  .text("📣 Send broadcast", async (ctx) => {
    if (!(await answerAdminOnlyCallback(ctx))) {
      return;
    }

    const key = adminTextKeyFromContext(ctx);
    const draft = key === null ? null : takeBroadcastDraft(key);

    if (draft === null) {
      await ctx.answerCallbackQuery({ text: "Broadcast expired." });
      return;
    }

    const sentCount = await sendBroadcast(ctx, draft.text);
    await ctx.editMessageText(`Broadcast sent to ${sentCount} chats.`);
  })
  .text("❌ Cancel", async (ctx) => {
    if (await answerAdminOnlyCallback(ctx)) {
      const key = adminTextKeyFromContext(ctx);

      if (key !== null) {
        takeBroadcastDraft(key);
      }

      await ctx.editMessageText("Broadcast canceled.");
    }
  });

export const registerAdminMenus = (): void => {
  adminMenu.register([
    adminChatsMenu,
    adminAccountsMenu,
    adminDiagnosticsMenu,
    adminForcePollMenu,
    adminForceDeliverMenu,
    adminBroadcastConfirmMenu
  ]);
};

export const registerAdminCommand = (bot: Bot): void => {
  bot.on("message:text", handleAdminTextInput);

  bot.command("admin", adminOnly, async (ctx) => {
    await ctx.reply(buildAdminMenuText(), {
      reply_markup: adminMenu
    });
  });
};
