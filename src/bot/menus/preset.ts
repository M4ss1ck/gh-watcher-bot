// Defines the filter preset picker menu.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { getDeliverer } from "~/bot/menus/deps";
import { presetMenuId, subscriptionMenuId } from "~/bot/menus/ids";
import { menuKeyFromContext } from "~/bot/menus/root";
import {
  buildSubscriptionMenuText,
  subscriptionMenu
} from "~/bot/menus/subscription";
import {
  clearFilterDraft,
  clearPresetDraft,
  getPresetDraft,
  getSelectedSubscription,
  setPresetDraft,
  updateSelectedSubscription,
  type SavedSubscriptionPreset
} from "~/bot/menus/state";
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import { subscriptionPresetValues, type SubscriptionPreset } from "~/db/schema";
import { updateSubscriptionFilters } from "~/db/queries";
import { clonePresetFilters } from "~/filters/presets";
import { formatSubscriptionPresetLabel } from "~/formatting/labels";
import { logger } from "~/lib/logger";

const isSavedSubscriptionPreset = (
  preset: SubscriptionPreset
): preset is SavedSubscriptionPreset => preset !== "custom";

type PresetFilterUpdater = (
  id: number,
  filters: ReturnType<typeof clonePresetFilters>,
  preset: SubscriptionPreset
) => Promise<void>;

export const selectableSubscriptionPresets =
  subscriptionPresetValues.filter(isSavedSubscriptionPreset);

export const formatPresetOptionLabel = (
  current: SubscriptionPreset,
  preset: SavedSubscriptionPreset
): string =>
  `${current === preset ? "◉" : "○"} ${formatSubscriptionPresetLabel(preset)}`;

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

export const savePresetSelection = async (input: {
  subscriptionId: number;
  key: Parameters<typeof updateSelectedSubscription>[0];
  preset: SavedSubscriptionPreset;
  updateFilters?: PresetFilterUpdater;
  sync?: () => Promise<void>;
}): Promise<void> => {
  const filters = clonePresetFilters(input.preset);
  const updateFilters = input.updateFilters ?? updateSubscriptionFilters;

  await updateFilters(input.subscriptionId, filters, input.preset);
  updateSelectedSubscription(input.key, { preset: input.preset });
  clearFilterDraft(input.key);
  clearPresetDraft(input.key);
  await (input.sync ?? syncDeliverer)();
};

const savePreset = async (ctx: Context): Promise<void> => {
  const key = menuKeyFromContext(ctx);
  const state = key === null ? null : getSelectedSubscription(key);

  if (key === null || state === null) {
    await ctx.answerCallbackQuery({
      text: "Subscription state lost. Open /subscribe again."
    });
    return;
  }

  const preset = getPresetDraft(key);

  try {
    await savePresetSelection({
      subscriptionId: state.id,
      key,
      preset
    });
  } catch (error) {
    logger.error({ err: error, subscription_id: state.id }, "preset save failed");
    await ctx.answerCallbackQuery({ text: "Save failed. Try again." });
    return;
  }

  await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
    reply_markup: subscriptionMenu
  });
};

export const presetMenu = new Menu<Context>(presetMenuId)
  .dynamic((ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const current = key === null ? "firehose" : getPresetDraft(key);

    for (const preset of selectableSubscriptionPresets) {
      range
        .text(formatPresetOptionLabel(current, preset), async (menuCtx) => {
          if (!(await requireChatAdminCallback(menuCtx))) {
            return;
          }

          if (key !== null) {
            setPresetDraft(key, preset);
          }

          menuCtx.menu.update();
        })
        .row();
    }

    return range;
  })
  .text("💾 Save", async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    await savePreset(ctx);
  })
  .text("❌ Cancel", async (ctx) => {
    const key = menuKeyFromContext(ctx);

    if (key !== null) {
      clearPresetDraft(key);
    }

    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  });
