// Wires grammY bot setup, middleware, menus, throttling, and retry behavior.
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { Bot, type Transformer } from "grammy";

import { registerHelpCommand } from "~/bot/commands/help";
import { registerPingCommand } from "~/bot/commands/ping";
import { registerStartCommand } from "~/bot/commands/start";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

const htmlParseModeMethods = new Set([
  "sendMessage",
  "editMessageText",
  "sendPhoto",
  "sendVideo",
  "sendAnimation",
  "sendAudio",
  "sendDocument",
  "sendVoice"
]);

const htmlParseMode: Transformer = (previous, method, payload, signal) => {
  if (htmlParseModeMethods.has(method)) {
    const mutablePayload = payload as Record<string, unknown>;

    if (mutablePayload.parse_mode === undefined) {
      mutablePayload.parse_mode = "HTML";
    }
  }

  return previous(method, payload, signal);
};

export const createBot = (): Bot => {
  const bot = new Bot(env.BOT_TOKEN);

  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3 }));
  bot.api.config.use(htmlParseMode);

  registerStartCommand(bot);
  registerHelpCommand(bot);
  registerPingCommand(bot);

  bot.catch((error) => {
    logger.error({ err: error.error }, "bot middleware error");
  });

  return bot;
};
