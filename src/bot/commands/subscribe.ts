// Handles subscribe command entry points and subscription menu routing.
import type { Bot, Context, NextFunction } from "grammy";

import { getDeliverer, getGitHubClient } from "~/bot/menus/deps";
import { buildRootMenuText, menuKeyFromContext } from "~/bot/menus/root";
import { rootMenu } from "~/bot/menus/root";
import {
  buildSubscriptionMenuTextFromState
} from "~/bot/menus/root";
import { subscriptionMenu } from "~/bot/menus/subscription";
import { isSupportedTimezone } from "~/bot/menus/timezone";
import {
  channelPostUserId,
  textInputs,
  TextInputTtlMap
} from "~/bot/menus/textInput";
import { setSelectedSubscription, updateSelectedSubscription } from "~/bot/menus/state";
import { chatAdminOnly } from "~/bot/middleware/chatAdminOnly";
import {
  createOrUpdateSubscription,
  listSubscriptionsForChat,
  resolveOrCreateGitHubAccount,
  resolveOrCreateGitHubRepo,
  updateSubscriptionSchedule
} from "~/db/queries";
import { clonePresetFilters } from "~/filters/presets";
import { escapeHtml, renderAccountSummary } from "~/formatting/render";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

export { TextInputTtlMap };

type CommandScope = {
  chatId: number;
  userId: number;
  keepMenuState: boolean;
};

export const normalizeGitHubLogin = (value: string): string | null => {
  const login = value.trim().replace(/^@/, "");

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    return null;
  }

  return login;
};

export type SubscribeTarget =
  | { type: "account"; login: string }
  | { type: "repo"; owner: string; repo: string };

export const subscribeUsageText =
  "Usage: /subscribe github_username or /subscribe owner/repo";

const repoNamePattern = /^[\w.-]+$/;

const parseGitHubUrlPath = (value: string): string | null => {
  const trimmed = value.trim();
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return null;
  }

  const parts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.slice(0, 2).join("/");
};

export const parseSubscribeTarget = (value: string): SubscribeTarget | null => {
  const trimmed = value.trim();
  const urlPath =
    /^https?:\/\/(www\.)?github\.com\//i.test(trimmed) ||
    /^(www\.)?github\.com\//i.test(trimmed)
      ? parseGitHubUrlPath(trimmed)
      : null;
  const input = (urlPath ?? trimmed).replace(/^@/, "");

  if (input.includes("/")) {
    const match = /^([\w.-]+)\/([\w.-]+)$/.exec(input);

    if (match === null) {
      return null;
    }

    const owner = normalizeGitHubLogin(match[1] ?? "");

    if (owner === null) {
      return null;
    }

    const repo = match[2] ?? "";

    if (!repoNamePattern.test(repo)) {
      return null;
    }

    return {
      type: "repo",
      owner,
      repo
    };
  }

  const login = normalizeGitHubLogin(input);

  return login === null ? null : { type: "account", login };
};

const getCommandArgument = (ctx: Context & { match?: string }): string =>
  typeof ctx.match === "string" ? ctx.match.trim() : "";

const commandScopeFromContext = (ctx: Context): CommandScope | null => {
  if (ctx.chat === undefined) {
    return null;
  }

  if (ctx.from !== undefined) {
    return {
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      keepMenuState: true
    };
  }

  if (ctx.chat.type === "channel" && ctx.channelPost !== undefined) {
    return {
      chatId: ctx.chat.id,
      userId: channelPostUserId,
      keepMenuState: false
    };
  }

  return null;
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

const openSubscriptionForUsername = async (
  ctx: Context,
  target: SubscribeTarget
): Promise<void> => {
  const scope = commandScopeFromContext(ctx);

  if (scope === null) {
    await ctx.reply("Open this command from a chat.");
    return;
  }

  const client = getGitHubClient();

  if (client === null) {
    await ctx.reply("GitHub client unavailable. Try again later.");
    return;
  }

  try {
    const existing = await listSubscriptionsForChat(scope.chatId);
    const ownerLogin = target.type === "account" ? target.login : target.owner;
    const account = await resolveOrCreateGitHubAccount(ownerLogin, client);
    const alreadyHasAccount = existing.some(
      (item) => item.accountLogin.toLowerCase() === account.login.toLowerCase()
    );

    if (!alreadyHasAccount && existing.length >= env.MAX_SUBS_PER_CHAT) {
      await ctx.reply(
        `This chat already has the maximum of ${env.MAX_SUBS_PER_CHAT} subscriptions.`
      );
      return;
    }

    const existingSubscription = existing.find(
      (item) => item.accountLogin.toLowerCase() === account.login.toLowerCase()
    );
    const selectedRepos =
      target.type === "account"
        ? existingSubscription?.selectedRepos ?? null
        : await resolveSelectedReposForRepoTarget({
            accountId: account.id,
            owner: account.login,
            repo: target.repo,
            existingSelectedRepos: existingSubscription?.selectedRepos,
            client
          });

    const id = await createOrUpdateSubscription({
      chatId: scope.chatId,
      accountId: account.id,
      preset: "firehose",
      filters: clonePresetFilters("firehose"),
      schedulePreset: "hourly",
      timezone: "UTC",
      selectedRepos,
      createdByUserId: scope.userId,
      lastDeliveredAt: null
    });
    const state = {
      id,
      accountId: account.id,
      accountLogin: account.login,
      preset: "firehose" as const,
      schedulePreset: "hourly" as const,
      timezone: "UTC",
      selectedRepos,
      paused: false,
      lastDeliveredAt: null
    };

    if (scope.keepMenuState) {
      setSelectedSubscription(
        {
          chatId: scope.chatId,
          userId: scope.userId
        },
        state
      );
    }

    await syncDeliverer();

    await ctx.reply(renderAccountSummary(account, state));

    if (scope.keepMenuState) {
      await ctx.reply(buildSubscriptionMenuTextFromState(state), {
        reply_markup: subscriptionMenu
      });
      return;
    }

    await ctx.reply(buildRootMenuText(), {
      reply_markup: rootMenu
    });
  } catch (error) {
    const label =
      target.type === "account" ? target.login : `${target.owner}/${target.repo}`;
    logger.error({ err: error, account_login: label }, "subscription create failed");
    await ctx.reply(formatSubscriptionCreateError(label, error));
  }
};

const resolveSelectedReposForRepoTarget = async (input: {
  accountId: number;
  owner: string;
  repo: string;
  existingSelectedRepos: string[] | null | undefined;
  client: Parameters<typeof resolveOrCreateGitHubRepo>[0]["client"];
}): Promise<string[] | null> => {
  const repo = await resolveOrCreateGitHubRepo({
    accountId: input.accountId,
    owner: input.owner,
    repo: input.repo,
    client: input.client
  });

  if (input.existingSelectedRepos === null) {
    return null;
  }

  if (input.existingSelectedRepos === undefined) {
    return [repo.name];
  }

  return [...new Set([...input.existingSelectedRepos, repo.name])].sort();
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

  return `<code>@${escapeHtml(login)}</code>`;
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
  const text = ctx.msg?.text;

  if (text === undefined || ctx.chat === undefined) {
    await next();
    return;
  }

  if (text.startsWith("/")) {
    await next();
    return;
  }

  const userId =
    ctx.from?.id ??
    (ctx.chat.type === "channel" && ctx.channelPost !== undefined
      ? channelPostUserId
      : null);

  if (userId === null) {
    await next();
    return;
  }

  const key = {
    chatId: ctx.chat.id,
    userId
  };
  const waiting = textInputs.take(key);

  if (waiting === null) {
    await next();
    return;
  }

  if (waiting.waitingFor === "username") {
    const target = parseSubscribeTarget(text);

    if (target === null) {
      await ctx.reply("That does not look like a GitHub username.");
      return;
    }

    await openSubscriptionForUsername(ctx, target);
    return;
  }

  const timezone = text.trim();

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
  bot.on("msg:text", handleTextInput);

  bot.command("subscribe", chatAdminOnly, async (ctx) => {
    const argument = getCommandArgument(ctx);

    if (argument.length === 0) {
      await ctx.reply(buildRootMenuText(), {
        reply_markup: rootMenu
      });
      return;
    }

    const target = parseSubscribeTarget(argument);

    if (target === null) {
      await ctx.reply(subscribeUsageText);
      return;
    }

    await openSubscriptionForUsername(ctx, target);
  });
};
