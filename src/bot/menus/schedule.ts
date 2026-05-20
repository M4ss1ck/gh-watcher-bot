// Defines the schedule preset picker menu.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { schedulePresetValues, type SchedulePreset } from "~/db/schema";
import { scheduleMenuId, subscriptionMenuId } from "~/bot/menus/ids";
import {
  buildSubscriptionMenuText,
  subscriptionMenu
} from "~/bot/menus/subscription";
import { menuKeyFromContext } from "~/bot/menus/root";
import {
  getSelectedSubscription,
  updateSelectedSubscription
} from "~/bot/menus/state";

const setSchedule = (ctx: Context, schedulePreset: SchedulePreset): void => {
  const key = menuKeyFromContext(ctx);

  if (key !== null) {
    updateSelectedSubscription(key, { schedulePreset });
  }
};

export const scheduleMenu = new Menu<Context>(scheduleMenuId)
  .dynamic((ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    for (const preset of schedulePresetValues) {
      const selected = state?.schedulePreset === preset;
      range.text(`${selected ? "◉" : "○"} ${preset}`, (menuCtx) => {
        setSchedule(menuCtx, preset);
        menuCtx.menu.update();
      }).row();
    }

    return range;
  })
  .text("💾 Save", async (ctx) => {
    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  })
  .text("❌ Cancel", async (ctx) => {
    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  });
