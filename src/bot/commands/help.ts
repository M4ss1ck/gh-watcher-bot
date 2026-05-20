// Handles the help command summary.
import type { Bot } from "grammy";

export const helpMessage = [
  "Available commands:",
  "/start - introduce the bot",
  "/help - show this help",
  "/ping - check whether the bot is alive"
].join("\n");

export const registerHelpCommand = (bot: Bot): void => {
  bot.command("help", async (ctx) => {
    await ctx.reply(helpMessage);
  });
};
