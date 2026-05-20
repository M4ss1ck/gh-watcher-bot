// Defines the timezone picker menu and custom timezone entry flow.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { timezoneMenuId, subscriptionMenuId } from "~/bot/menus/ids";
import {
  buildSubscriptionMenuText,
  subscriptionMenu
} from "~/bot/menus/subscription";
import { menuKeyFromContext } from "~/bot/menus/root";
import {
  getSelectedSubscription,
  updateSelectedSubscription
} from "~/bot/menus/state";
import { textInputs } from "~/bot/menus/textInput";

export const commonTimezones = [
  "UTC",
  "America/Santiago",
  "America/New_York",
  "Europe/London",
  "Europe/Madrid",
  "Asia/Tokyo"
] as const;

export const isSupportedTimezone = (value: string): boolean =>
  value === "UTC" || Intl.supportedValuesOf("timeZone").includes(value);

export const timezoneMenu = new Menu<Context>(timezoneMenuId)
  .dynamic((ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    for (const timezone of commonTimezones) {
      range.text(
        `${state?.timezone === timezone ? "◉" : "○"} ${timezone}`,
        async (menuCtx) => {
          const menuKey = menuKeyFromContext(menuCtx);

          if (menuKey !== null) {
            updateSelectedSubscription(menuKey, { timezone });
          }

          await menuCtx.editMessageText(buildSubscriptionMenuText(menuCtx), {
            reply_markup: subscriptionMenu
          });
        }
      ).row();
    }

    return range;
  })
  .text("Other...", async (ctx) => {
    const key = menuKeyFromContext(ctx);

    if (key === null) {
      await ctx.answerCallbackQuery({ text: "Open this from a chat." });
      return;
    }

    textInputs.set(key, { waitingFor: "timezone" });
    await ctx.reply("Send an IANA timezone within 60 seconds.");
  })
  .row()
  .text("❌ Cancel", async (ctx) => {
    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  });
