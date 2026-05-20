// Handles admin command menu entry for configured administrators.
import { Menu } from "@grammyjs/menu";
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
import type {
  AdminAccountListItem,
  AdminChatListItem,
  AdminSubscriptionListItem
} from "~/db/queries";
import type { MetricsSnapshot } from "~/lib/metrics";
import { createGitHubClient } from "~/github/client";
import { pollGitHubAccount } from "~/github/poller";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { getMetricsSnapshot } from "~/lib/metrics";
import { runDeliveryTask } from "~/scheduler/deliverer";

export type AdminDiagnosticsInput = {
  lastCollectorTickAge: string;
  githubRateLimitRemaining: string;
  activeSubscriptions: number;
  activeChats: number;
  eventsIngestedLast24h: number;
  errorsLast24h: number;
  metrics?: Pick<
    MetricsSnapshot,
    "githubApiRequestsTotal" | "deliveriesSentTotal" | "telegramApiErrorsTotal"
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

export const isAdminUserId = (userId: number | undefined, adminIds = env.ADMIN_IDS): boolean =>
  userId !== undefined && adminIds.includes(userId);

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
): string => `#${item.id} @${item.accountLogin} ${item.schedulePreset}`;

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

  return {
    lastCollectorTickAge: formatCollectorTickAge(lastTickMs),
    githubRateLimitRemaining: "unknown",
    activeSubscriptions: counts.activeSubscriptions,
    activeChats: counts.activeChats,
    eventsIngestedLast24h: counts.eventsIngestedLast24h,
    errorsLast24h,
    metrics
  };
};

const assertAdmin = async (ctx: Context): Promise<boolean> => {
  if (isAdminUserId(ctx.from?.id)) {
    return true;
  }

  await ctx.reply("Admin only.");
  return false;
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
  .dynamic(async (_ctx, range) => {
    const queries = await import("~/db/queries");
    const chats = await queries.listAdminChats();

    for (const chat of chats) {
      range.text(formatAdminChatButton(chat), async (ctx) => {
        if (!(await answerAdminOnlyCallback(ctx))) {
          return;
        }

        await ctx.answerCallbackQuery({
          text: chat.active && !chat.banned ? "active" : "inactive"
        });
      }).row();
    }

    return range;
  })
  .back("◀️ Back", async (ctx) => {
    await ctx.editMessageText(buildAdminMenuText());
  });

export const adminAccountsMenu = new Menu<Context>(adminAccountsMenuId)
  .dynamic(async (_ctx, range) => {
    const queries = await import("~/db/queries");
    const accounts = await queries.listAdminAccounts();

    for (const account of accounts) {
      range.text(formatAdminAccountButton(account), async (ctx) => {
        if (!(await answerAdminOnlyCallback(ctx))) {
          return;
        }

        await ctx.answerCallbackQuery({
          text: `failures ${account.consecutiveFailures}`
        });
      }).row();
    }

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
  .dynamic(async (_ctx, range) => {
    const queries = await import("~/db/queries");
    const accounts = await queries.listAdminAccounts();

    for (const account of accounts) {
      range.text(formatAdminAccountButton(account), async (ctx) => {
        if (!(await answerAdminOnlyCallback(ctx))) {
          return;
        }

        const pollAccount = await queries.getGitHubAccountById(account.id);

        if (pollAccount === null) {
          await ctx.answerCallbackQuery({ text: "Account missing." });
          return;
        }

        const result = await pollGitHubAccount(pollAccount, {
          client: createGitHubClient()
        });

        await ctx.reply(
          `Force-poll @${result.login}: ${result.status}, inserted ${result.insertedCount}`
        );
      }).row();
    }

    return range;
  })
  .back("◀️ Back", async (ctx) => {
    await ctx.editMessageText(buildAdminMenuText());
  });

export const adminForceDeliverMenu = new Menu<Context>(adminForceDeliverMenuId)
  .dynamic(async (_ctx, range) => {
    const queries = await import("~/db/queries");
    const subscriptions = await queries.listAdminSubscriptions();

    for (const subscription of subscriptions) {
      range.text(formatAdminSubscriptionButton(subscription), async (ctx) => {
        if (!(await answerAdminOnlyCallback(ctx))) {
          return;
        }

        const result = await runDeliveryTask({
          subscriptionId: subscription.id,
          sendMessage: async (chatId, text) => {
            await ctx.api.sendMessage(chatId, text);
          }
        });

        await ctx.reply(
          `Force-deliver #${subscription.id}: ${result.status}, events ${result.eventCount}`
        );
      }).row();
    }

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

  bot.command("admin", async (ctx) => {
    if (!(await assertAdmin(ctx))) {
      return;
    }

    await ctx.reply(buildAdminMenuText(), {
      reply_markup: adminMenu
    });
  });
};
