// Wires grammY bot setup, middleware, menus, throttling, and retry behavior.
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { Bot, type Transformer } from "grammy";

import { adminMenu, registerAdminCommand, registerAdminMenus } from "~/bot/commands/admin";
import { registerHelpCommand } from "~/bot/commands/help";
import { registerPingCommand } from "~/bot/commands/ping";
import { registerStartCommand } from "~/bot/commands/start";
import { registerSubscribeCommand } from "~/bot/commands/subscribe";
import { filtersMenu } from "~/bot/menus/filters";
import { rootMenu, menuButtonStyleTransformer } from "~/bot/menus/root";
import { scheduleMenu } from "~/bot/menus/schedule";
import { subscriptionMenu } from "~/bot/menus/subscription";
import { timezoneMenu } from "~/bot/menus/timezone";
import { registerChatLifecycleHandlers } from "~/bot/middleware/chatRegistration";
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

let menusRegistered = false;

const registerMenus = (): void => {
  if (menusRegistered) {
    return;
  }

  rootMenu.register(subscriptionMenu);
  rootMenu.register([filtersMenu, scheduleMenu, timezoneMenu], "subscription-detail");
  registerAdminMenus();
  menusRegistered = true;
};

export const createBot = (): Bot => {
  const bot = new Bot(env.BOT_TOKEN);

  bot.api.config.use(apiThrottler());
  bot.api.config.use(
    autoRetry({ maxRetryAttempts: 3, retryOnInternalServerErrors: true })
  );
  bot.api.config.use(htmlParseMode);
  bot.api.config.use(menuButtonStyleTransformer);

  registerMenus();

  registerChatLifecycleHandlers(bot);
  bot.use(rootMenu);
  bot.use(adminMenu);
  registerStartCommand(bot);
  registerHelpCommand(bot);
  registerPingCommand(bot);
  registerAdminCommand(bot);
  registerSubscribeCommand(bot);

  bot.catch((error) => {
    logger.error({ err: error.error }, "bot middleware error");
  });

  return bot;
};
