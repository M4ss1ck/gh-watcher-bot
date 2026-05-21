// Defines the timezone picker menu and custom timezone entry flow.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { getDeliverer } from "~/bot/menus/deps";
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
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import { updateSubscriptionSchedule } from "~/db/queries";
import { logger } from "~/lib/logger";

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

export const timezoneMenu = new Menu<Context>(timezoneMenuId)
  .dynamic((ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    for (const timezone of commonTimezones) {
      range.text(
        `${state?.timezone === timezone ? "◉" : "○"} ${timezone}`,
        async (menuCtx) => {
          if (!(await requireChatAdminCallback(menuCtx))) {
            return;
          }

          const menuKey = menuKeyFromContext(menuCtx);

          if (menuKey === null) {
            return;
          }

          const updated = updateSelectedSubscription(menuKey, { timezone });

          if (updated === null) {
            await menuCtx.answerCallbackQuery({
              text: "Subscription state lost. Open /subscribe again."
            });
            return;
          }

          try {
            await updateSubscriptionSchedule(updated.id, updated.schedulePreset, timezone);
            await syncDeliverer();
          } catch (error) {
            logger.error(
              { err: error, subscription_id: updated.id },
              "timezone save failed"
            );
            await menuCtx.answerCallbackQuery({ text: "Save failed. Try again." });
            return;
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
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

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
