// Defines the schedule preset picker menu.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { getDeliverer } from "~/bot/menus/deps";
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
import { isAdminUserId } from "~/bot/middleware/adminOnly";
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import type { SchedulePreset } from "~/db/schema";
import { updateSubscriptionSchedule } from "~/db/queries";
import { formatSchedulePresetLabel } from "~/formatting/labels";
import { logger } from "~/lib/logger";
import { getVisibleSchedulePresetValues } from "~/scheduler/presets";

const setSchedule = (ctx: Context, schedulePreset: SchedulePreset): void => {
  const key = menuKeyFromContext(ctx);

  if (key !== null) {
    updateSelectedSubscription(key, { schedulePreset });
  }
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

export const scheduleMenu = new Menu<Context>(scheduleMenuId)
  .dynamic((ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    for (const preset of getVisibleSchedulePresetValues(isAdminUserId(ctx.from?.id))) {
      const selected = state?.schedulePreset === preset;
      range.text(`${selected ? "◉" : "○"} ${formatSchedulePresetLabel(preset)}`, async (menuCtx) => {
        if (!(await requireChatAdminCallback(menuCtx))) {
          return;
        }

        setSchedule(menuCtx, preset);
        menuCtx.menu.update();
      }).row();
    }

    return range;
  })
  .text("💾 Save", async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (state === null) {
      await ctx.answerCallbackQuery({
        text: "Subscription state lost. Open /subscribe again."
      });
      return;
    }

    try {
      await updateSubscriptionSchedule(state.id, state.schedulePreset, state.timezone);
      await syncDeliverer();
    } catch (error) {
      logger.error({ err: error, subscription_id: state.id }, "schedule save failed");
      await ctx.answerCallbackQuery({ text: "Save failed. Try again." });
      return;
    }

    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  })
  .text("❌ Cancel", async (ctx) => {
    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  });
