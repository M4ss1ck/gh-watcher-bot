// Handles subscribe command entry points and subscription menu routing.
import type { Bot, Context, NextFunction } from "grammy";

import { applyReposInput } from "~/bot/menus/filters";
import { buildRootMenuText, menuKeyFromContext, openDraftSubscription } from "~/bot/menus/root";
import { rootMenu } from "~/bot/menus/root";
import {
  buildSubscriptionMenuTextFromState
} from "~/bot/menus/root";
import { subscriptionMenu } from "~/bot/menus/subscription";
import { isSupportedTimezone } from "~/bot/menus/timezone";
import { textInputs, TextInputTtlMap } from "~/bot/menus/textInput";
import { updateSelectedSubscription } from "~/bot/menus/state";
import { chatAdminOnly } from "~/bot/middleware/chatAdminOnly";
import { updateSubscriptionSchedule } from "~/db/queries";

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

const openSubscriptionForUsername = async (
  ctx: Context,
  username: string
): Promise<void> => {
  const key = menuKeyFromContext(ctx);

  if (key === null) {
    await ctx.reply("Open this command from a chat.");
    return;
  }

  const state = openDraftSubscription(key, username);

  await ctx.reply(buildSubscriptionMenuTextFromState(state), {
    reply_markup: subscriptionMenu
  });
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

  if (updated?.id != null) {
    await updateSubscriptionSchedule(updated.id, updated.schedulePreset, timezone);
  }

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
