// Handles the help command summary.
import type { Bot, Context } from "grammy";

import { isAdminUserId } from "~/bot/middleware/adminOnly";

const publicLines = [
  "/start - introduce the bot",
  "/help - show this help",
  "/ping - check whether the bot is alive",
  "/subscribe - manage GitHub subscriptions for this chat"
];

const adminLines = ["/admin - admin menu (diagnostics, broadcast, force actions)"];

export const buildHelpMessage = (isAdmin: boolean): string => {
  const lines = ["Available commands:", ...publicLines];

  if (isAdmin) {
    lines.push(...adminLines);
  }

  return lines.join("\n");
};

export const registerHelpCommand = (bot: Bot): void => {
  bot.command("help", async (ctx: Context) => {
    await ctx.reply(buildHelpMessage(isAdminUserId(ctx.from?.id)));
  });
};
