// Defines the subscription detail menu and per-subscription actions.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { getDeliverer, getGitHubClient } from "~/bot/menus/deps";
import {
  filtersMenuId,
  rootMenuId,
  scheduleMenuId,
  subscriptionDeleteConfirmMenuId,
  subscriptionMenuId,
  timezoneMenuId
} from "~/bot/menus/ids";
import {
  buildSubscriptionMenuTextFromState,
  menuKeyFromContext
} from "~/bot/menus/root";
import {
  clearSelectedSubscription,
  getSelectedSubscription,
  updateSelectedSubscription
} from "~/bot/menus/state";
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import {
  deleteSubscription,
  getGitHubAccountById,
  setSubscriptionPaused
} from "~/db/queries";
import type { GitHubAccountForPolling } from "~/db/queries";
import {
  pollGitHubAccount,
  type GitHubEventsClient,
  type PollResult
} from "~/github/poller";
import { logger } from "~/lib/logger";
import {
  runDeliveryTask,
  type DeliverySendMessage,
  type DeliveryTaskResult
} from "~/scheduler/deliverer";

type PreviewDeliver = (options: {
  subscriptionId: number;
  sendMessage: DeliverySendMessage;
}) => Promise<DeliveryTaskResult>;

export type SubscriptionPreviewOptions = {
  subscriptionId: number;
  accountId: number;
  accountLogin: string;
  client?: GitHubEventsClient | null;
  getAccountById?: (accountId: number) => Promise<GitHubAccountForPolling | null>;
  pollAccount?: (
    account: GitHubAccountForPolling,
    options: { client: GitHubEventsClient }
  ) => Promise<PollResult>;
  deliver?: PreviewDeliver;
  sendMessage: DeliverySendMessage;
  reply: (text: string) => Promise<void>;
};

export const buildSubscriptionMenuText = (ctx: Context): string => {
  const key = menuKeyFromContext(ctx);
  const state = key === null ? null : getSelectedSubscription(key);

  if (state === null) {
    return "No subscription selected.";
  }

  return buildSubscriptionMenuTextFromState(state);
};

const editToCurrentSubscription = async (ctx: Context): Promise<void> => {
  await ctx.editMessageText(buildSubscriptionMenuText(ctx));
};

const syncDeliverer = async (): Promise<void> => {
  const deliverer = getDeliverer();

  if (deliverer === null) {
    return;
  }

  try {
    await deliverer.sync();
  } catch (error) {
    logger.error({ err: error }, "deliverer sync failed");
  }
};

const formatGitHubMention = (login: string): string => `@${login.replace(/^@+/, "")}`;

const formatPollFailureMessage = (
  accountLogin: string,
  result: Extract<PollResult, { status: "failed" }>
): string => {
  const suffix =
    result.failureStatus === null
      ? "GitHub could not be reached."
      : `GitHub returned ${result.failureStatus}.`;

  return `Could not refresh ${formatGitHubMention(accountLogin)} before preview. ${suffix}`;
};

export const runSubscriptionPreview = async (
  options: SubscriptionPreviewOptions
): Promise<DeliveryTaskResult | null> => {
  const client = options.client ?? getGitHubClient();

  if (client === null) {
    await options.reply("GitHub client unavailable. Try again later.");
    return null;
  }

  const getAccountById = options.getAccountById ?? getGitHubAccountById;
  const account = await getAccountById(options.accountId);

  if (account === null) {
    await options.reply(
      `GitHub account ${formatGitHubMention(options.accountLogin)} is missing. Open /subscribe again.`
    );
    return null;
  }

  const pollAccount = options.pollAccount ?? pollGitHubAccount;
  const pollResult = await pollAccount(account, { client });

  if (pollResult.status === "failed") {
    await options.reply(formatPollFailureMessage(options.accountLogin, pollResult));
    return null;
  }

  if (pollResult.status === "skipped_paused") {
    await options.reply(
      `GitHub polling for ${formatGitHubMention(options.accountLogin)} is paused until ${pollResult.pausedUntil.toISOString()}.`
    );
    return null;
  }

  const deliver = options.deliver ?? runDeliveryTask;
  const result = await deliver({
    subscriptionId: options.subscriptionId,
    sendMessage: options.sendMessage
  });

  if (result.status === "empty") {
    await options.reply(
      `No new events for ${formatGitHubMention(options.accountLogin)} since last delivery. The collector polls every 10 min.`
    );
  }

  return result;
};

export const subscriptionMenu = new Menu<Context>(subscriptionMenuId)
  .submenu("⚙️ Filters", filtersMenuId, async (ctx) => {
    await ctx.editMessageText("Filters");
  })
  .submenu("🕐 Schedule", scheduleMenuId, async (ctx) => {
    await ctx.editMessageText("Schedule");
  })
  .submenu("🌍 Timezone", timezoneMenuId, async (ctx) => {
    await ctx.editMessageText("Timezone");
  })
  .row()
  .text(
    (ctx) => {
      const key = menuKeyFromContext(ctx);
      const state = key === null ? null : getSelectedSubscription(key);

      return state?.paused === true ? "▶️ Resume" : "⏸ Pause";
    },
    async (ctx) => {
      if (!(await requireChatAdminCallback(ctx))) {
        return;
      }

      const key = menuKeyFromContext(ctx);
      const state = key === null ? null : getSelectedSubscription(key);

      if (key === null || state === null) {
        return;
      }

      const nextPaused = !state.paused;
      await setSubscriptionPaused(state.id, nextPaused);
      updateSelectedSubscription(key, { paused: nextPaused });
      await syncDeliverer();
      await editToCurrentSubscription(ctx);
    }
  )
  .text("👁 Preview now", async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (state === null) {
      await ctx.answerCallbackQuery({
        text: "Subscription state lost. Open /subscribe again."
      });
      return;
    }

    try {
      await runSubscriptionPreview({
        subscriptionId: state.id,
        accountId: state.accountId,
        accountLogin: state.accountLogin,
        sendMessage: async (chatId, text) => {
          await ctx.api.sendMessage(chatId, text);
        },
        reply: async (text) => {
          await ctx.reply(text);
        }
      });
      await ctx.answerCallbackQuery();
    } catch (error) {
      logger.error({ err: error, subscription_id: state.id }, "preview failed");
      await ctx.reply("Preview failed. Try again later.");
      await ctx.answerCallbackQuery({ text: "Preview failed." });
    }
  })
  .row()
  .submenu("🗑 Delete", subscriptionDeleteConfirmMenuId, async (ctx) => {
    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (state === null) {
      await ctx.editMessageText("Subscription state lost. Open /subscribe again.");
      return;
    }

    await ctx.editMessageText(`Delete subscription for @${state.accountLogin}?`);
  })
  .row()
  .submenu("◀️ Back", rootMenuId, async (ctx) => {
    await ctx.editMessageText("Subscriptions in this chat");
  });

export const subscriptionDeleteConfirmMenu = new Menu<Context>(
  subscriptionDeleteConfirmMenuId
)
  .submenu("🗑 Confirm delete", rootMenuId, async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (key === null || state === null) {
      await ctx.editMessageText("Subscriptions in this chat");
      return;
    }

    await deleteSubscription(state.id);
    clearSelectedSubscription(key);
    await syncDeliverer();
    await ctx.editMessageText("Subscriptions in this chat");
  })
  .submenu("◀️ Cancel", subscriptionMenuId, async (ctx) => {
    await editToCurrentSubscription(ctx);
  });
