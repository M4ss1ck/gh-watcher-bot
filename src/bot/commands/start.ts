// Handles the start command onboarding text.
import type { Bot } from "grammy";

export const privateStartMessage =
  "Hi. I watch public GitHub activity and send Telegram digest updates on a schedule. Use /subscribe to add a GitHub user, or /help for the full command list.";

export const groupStartMessage =
  "Hi. I watch public GitHub activity for this chat. Chat admins can run /subscribe to set up digests. Use /help to see what is available.";

export const registerStartCommand = (bot: Bot): void => {
  bot.command("start", async (ctx) => {
    const message =
      ctx.chat?.type === "private" ? privateStartMessage : groupStartMessage;

    await ctx.reply(message);
  });
};
