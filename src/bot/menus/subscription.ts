// Defines the subscription detail menu and per-subscription actions.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import {
  filtersMenuId,
  rootMenuId,
  scheduleMenuId,
  subscriptionMenuId,
  timezoneMenuId
} from "~/bot/menus/ids";
import {
  buildSubscriptionMenuTextFromState,
  menuKeyFromContext
} from "~/bot/menus/root";
import {
  getSelectedSubscription,
  updateSelectedSubscription
} from "~/bot/menus/state";

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
      const key = menuKeyFromContext(ctx);
      const state = key === null ? null : getSelectedSubscription(key);

      if (key !== null && state !== null) {
        updateSelectedSubscription(key, { paused: !state.paused });
      }

      await editToCurrentSubscription(ctx);
    }
  )
  .text("👁 Preview now", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Preview delivery is not wired yet." });
  })
  .row()
  .text("🗑 Delete", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Delete is not wired yet." });
  })
  .row()
  .submenu("◀️ Back", rootMenuId, async (ctx) => {
    await ctx.editMessageText("Subscriptions in this chat");
  });
