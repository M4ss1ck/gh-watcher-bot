// Handles subscribe command entry points and subscription menu routing.
import type { Bot, Context, NextFunction } from "grammy";

import { applyReposInput } from "~/bot/menus/filters";
import { getDeliverer, getGitHubClient } from "~/bot/menus/deps";
import { buildRootMenuText, menuKeyFromContext } from "~/bot/menus/root";
import { rootMenu } from "~/bot/menus/root";
import {
  buildSubscriptionMenuTextFromState
} from "~/bot/menus/root";
import { subscriptionMenu } from "~/bot/menus/subscription";
import { isSupportedTimezone } from "~/bot/menus/timezone";
import { textInputs, TextInputTtlMap } from "~/bot/menus/textInput";
import { setSelectedSubscription, updateSelectedSubscription } from "~/bot/menus/state";
import { chatAdminOnly } from "~/bot/middleware/chatAdminOnly";
import {
  createOrUpdateSubscription,
  listSubscriptionsForChat,
  resolveOrCreateGitHubAccount,
  updateSubscriptionSchedule
} from "~/db/queries";
import { clonePresetFilters } from "~/filters/presets";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

export { TextInputTtlMap };

export const normalizeGitHubLogin = (value: string): string | null => {
  const login = value.trim().replace(/^@/, "");

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    return null;
  }

  return login;
};

const getCommandArgument = (ctx: Context & { match?: string }): string =>
  typeof ctx.match === "string" ? ctx.match.trim() : "";

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

const openSubscriptionForUsername = async (
  ctx: Context,
  username: string
): Promise<void> => {
  const key = menuKeyFromContext(ctx);

  if (key === null) {
    await ctx.reply("Open this command from a chat.");
    return;
  }

  const client = getGitHubClient();

  if (client === null) {
    await ctx.reply("GitHub client unavailable. Try again later.");
    return;
  }

  try {
    const existing = await listSubscriptionsForChat(key.chatId);
    const account = await resolveOrCreateGitHubAccount(username, client);
    const alreadyHasAccount = existing.some(
      (item) => item.accountLogin.toLowerCase() === account.login.toLowerCase()
    );

    if (!alreadyHasAccount && existing.length >= env.MAX_SUBS_PER_CHAT) {
      await ctx.reply(
        `This chat already has the maximum of ${env.MAX_SUBS_PER_CHAT} subscriptions.`
      );
      return;
    }

    const id = await createOrUpdateSubscription({
      chatId: key.chatId,
      accountId: account.id,
      preset: "firehose",
      filters: clonePresetFilters("firehose"),
      schedulePreset: "hourly",
      timezone: "UTC",
      createdByUserId: key.userId,
      lastDeliveredAt: null
    });
    const state = {
      id,
      accountId: account.id,
      accountLogin: account.login,
      preset: "firehose" as const,
      schedulePreset: "hourly" as const,
      timezone: "UTC",
      paused: false,
      lastDeliveredAt: null
    };

    setSelectedSubscription(key, state);
    await syncDeliverer();

    await ctx.reply(buildSubscriptionMenuTextFromState(state), {
      reply_markup: subscriptionMenu
    });
  } catch (error) {
    logger.error({ err: error, account_login: username }, "subscription create failed");
    await ctx.reply(formatSubscriptionCreateError(username, error));
  }
};

const getErrorStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }

  const status = (error as { status: unknown }).status;

  return typeof status === "number" ? status : null;
};

const getErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return null;
};

const formatGitHubLoginMention = (value: string): string => {
  const login = normalizeGitHubLogin(value) ?? value.trim().replace(/^@+/, "");

  return `@${login}`;
};

export const formatSubscriptionCreateError = (
  username: string,
  error: unknown
): string => {
  const mention = formatGitHubLoginMention(username);

  if (getErrorStatus(error) === 404) {
    return `GitHub user ${mention} was not found.`;
  }

  const message = getErrorMessage(error);

  return message === null
    ? `Could not create a subscription for ${mention}. Try again later.`
    : `Could not create a subscription for ${mention}: ${message}`;
};

const handleTextInput = async (
  ctx: Context,
  next: NextFunction
): Promise<void> => {
  if (ctx.message?.text === undefined || ctx.chat === undefined || ctx.from === undefined) {
    await next();
    return;
  }

  if (ctx.message.text.startsWith("/")) {
    await next();
    return;
  }

  const key = {
    chatId: ctx.chat.id,
    userId: ctx.from.id
  };
  const waiting = textInputs.take(key);

  if (waiting === null) {
    await next();
    return;
  }

  if (waiting.waitingFor === "username") {
    const username = normalizeGitHubLogin(ctx.message.text);

    if (username === null) {
      await ctx.reply("That does not look like a GitHub username.");
      return;
    }

    await openSubscriptionForUsername(ctx, username);
    return;
  }

  if (waiting.waitingFor === "repos") {
    applyReposInput(key, ctx.message.text);
    await ctx.reply("Repos updated. Open Filters and tap Save to commit.");
    return;
  }

  const timezone = ctx.message.text.trim();

  if (!isSupportedTimezone(timezone)) {
    await ctx.reply("That does not look like a valid IANA timezone.");
    return;
  }

  const updated = updateSelectedSubscription(key, { timezone });

  if (updated === null) {
    await ctx.reply("Subscription state lost. Open /subscribe again.");
    return;
  }

  await updateSubscriptionSchedule(updated.id, updated.schedulePreset, timezone);

  await ctx.reply(`Timezone set to ${timezone}.`, {
    reply_markup: subscriptionMenu
  });
};

export const registerSubscribeCommand = (bot: Bot): void => {
  bot.on("message:text", handleTextInput);

  bot.command("subscribe", chatAdminOnly, async (ctx) => {
    const argument = getCommandArgument(ctx);

    if (argument.length === 0) {
      await ctx.reply(buildRootMenuText(), {
        reply_markup: rootMenu
      });
      return;
    }

    const username = normalizeGitHubLogin(argument);

    if (username === null) {
      await ctx.reply("Usage: /subscribe <github_username>");
      return;
    }

    await openSubscriptionForUsername(ctx, username);
  });
};
