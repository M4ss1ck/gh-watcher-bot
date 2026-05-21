// Defines the subscription detail menu and per-subscription actions.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { getDeliverer } from "~/bot/menus/deps";
import {
  filtersMenuId,
  rootMenuId,
  scheduleMenuId,
  subscriptionDeleteConfirmMenuId,
  subscriptionMenuId,
  timezoneMenuId
} from "~/bot/menus/ids";
import {
  buildSubscriptionMenuTextFromState,
  menuKeyFromContext
} from "~/bot/menus/root";
import {
  clearSelectedSubscription,
  getSelectedSubscription,
  updateSelectedSubscription
} from "~/bot/menus/state";
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import {
  deleteSubscription,
  setSubscriptionPaused
} from "~/db/queries";
import { logger } from "~/lib/logger";
import { runDeliveryTask } from "~/scheduler/deliverer";

export const buildSubscriptionMenuText = (ctx: Context): string => {
  const key = menuKeyFromContext(ctx);
  const state = key === null ? null : getSelectedSubscription(key);

  if (state === null) {
    return "No subscription selected.";
  }

  return buildSubscriptionMenuTextFromState(state);
};

const editToCurrentSubscription = async (ctx: Context): Promise<void> => {
  await ctx.editMessageText(buildSubscriptionMenuText(ctx));
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

export const subscriptionMenu = new Menu<Context>(subscriptionMenuId)
  .submenu("⚙️ Filters", filtersMenuId, async (ctx) => {
    await ctx.editMessageText("Filters");
  })
  .submenu("🕐 Schedule", scheduleMenuId, async (ctx) => {
    await ctx.editMessageText("Schedule");
  })
  .submenu("🌍 Timezone", timezoneMenuId, async (ctx) => {
    await ctx.editMessageText("Timezone");
  })
  .row()
  .text(
    (ctx) => {
      const key = menuKeyFromContext(ctx);
      const state = key === null ? null : getSelectedSubscription(key);

      return state?.paused === true ? "▶️ Resume" : "⏸ Pause";
    },
    async (ctx) => {
      if (!(await requireChatAdminCallback(ctx))) {
        return;
      }

      const key = menuKeyFromContext(ctx);
      const state = key === null ? null : getSelectedSubscription(key);

      if (key === null || state === null) {
        return;
      }

      if (state.id === null) {
        await ctx.answerCallbackQuery({ text: "Save the subscription first." });
        return;
      }

      const nextPaused = !state.paused;
      await setSubscriptionPaused(state.id, nextPaused);
      updateSelectedSubscription(key, { paused: nextPaused });
      await syncDeliverer();
      await editToCurrentSubscription(ctx);
    }
  )
  .text("👁 Preview now", async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (state === null || state.id === null) {
      await ctx.answerCallbackQuery({ text: "Save the subscription first." });
      return;
    }

    try {
      const result = await runDeliveryTask({
        subscriptionId: state.id,
        sendMessage: async (chatId, text) => {
          await ctx.api.sendMessage(chatId, text);
        }
      });
      await ctx.answerCallbackQuery({
        text: `Preview ${result.status}, events ${result.eventCount}.`
      });
    } catch (error) {
      logger.error({ err: error, subscription_id: state.id }, "preview failed");
      await ctx.answerCallbackQuery({ text: "Preview failed." });
    }
  })
  .row()
  .submenu("🗑 Delete", subscriptionDeleteConfirmMenuId, async (ctx) => {
    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (state === null || state.id === null) {
      await ctx.editMessageText("Save the subscription first.");
      return;
    }

    await ctx.editMessageText(`Delete subscription for @${state.accountLogin}?`);
  })
  .row()
  .submenu("◀️ Back", rootMenuId, async (ctx) => {
    await ctx.editMessageText("Subscriptions in this chat");
  });

export const subscriptionDeleteConfirmMenu = new Menu<Context>(
  subscriptionDeleteConfirmMenuId
)
  .submenu("🗑 Confirm delete", rootMenuId, async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (key === null || state === null || state.id === null) {
      await ctx.editMessageText("Subscriptions in this chat");
      return;
    }

    await deleteSubscription(state.id);
    clearSelectedSubscription(key);
    await syncDeliverer();
    await ctx.editMessageText("Subscriptions in this chat");
  })
  .submenu("◀️ Cancel", subscriptionMenuId, async (ctx) => {
    await editToCurrentSubscription(ctx);
  });
