// Defines the filter editor menu for subscription drafts.
import { Menu, MenuRange } from "@grammyjs/menu";
import type { Context } from "grammy";

import { filterEventValues, type FilterEvent } from "~/db/schema";
import { clonePresetFilters } from "~/filters/presets";
import { getDeliverer } from "~/bot/menus/deps";
import { filtersMenuId, reposMenuId, subscriptionMenuId } from "~/bot/menus/ids";
import { formatRepoSelectionLabel } from "~/bot/menus/repos";
import {
  buildSubscriptionMenuText,
  subscriptionMenu
} from "~/bot/menus/subscription";
import { menuKeyFromContext } from "~/bot/menus/root";
import {
  clearFilterDraft,
  getFilterDraft,
  getSelectedSubscription,
  setFilterDraft,
  updateSelectedSubscription,
} from "~/bot/menus/state";
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import { updateSubscriptionFilters } from "~/db/queries";
import { logger } from "~/lib/logger";

const eventRows: FilterEvent[][] = [
  ["push", "pull_request"],
  ["issues", "release"],
  ["fork", "star"],
  ["repository", "create"]
];

const toggleEvent = (ctx: Context, event: FilterEvent): void => {
  const key = menuKeyFromContext(ctx);

  if (key === null) {
    return;
  }

  const draft = getFilterDraft(key);
  const enabled = draft.filters.events.includes(event);
  const events = enabled
    ? draft.filters.events.filter((item) => item !== event)
    : [...draft.filters.events, event];

  setFilterDraft(key, {
    preset: "custom",
    filters: {
      ...draft.filters,
      events
    }
  });
  updateSelectedSubscription(key, { preset: "custom" });
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

const saveFilters = async (ctx: Context): Promise<void> => {
  const key = menuKeyFromContext(ctx);

  if (key === null) {
    await ctx.answerCallbackQuery({ text: "Open this from a chat." });
    return;
  }

  const draft = getFilterDraft(key);
  const current = getSelectedSubscription(key);

  if (current === null) {
    await ctx.answerCallbackQuery({
      text: "Subscription state lost. Open /subscribe again."
    });
    return;
  }

  try {
    await updateSubscriptionFilters(current.id, draft.filters, draft.preset);
    updateSelectedSubscription(key, { preset: draft.preset });
  } catch (error) {
    logger.error({ err: error, subscription_id: current.id }, "filter save failed");
    await ctx.answerCallbackQuery({ text: "Save failed. Try again." });
    return;
  }

  clearFilterDraft(key);
  await syncDeliverer();
  await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
    reply_markup: subscriptionMenu
  });
};

export const buildFiltersHeaderText = (): string => "Filters";

export const filtersMenu = new Menu<Context>(filtersMenuId)
  .dynamic((ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const draft = key === null ? null : getFilterDraft(key);

    for (const row of eventRows) {
      for (const event of row) {
        const enabled = draft?.filters.events.includes(event) ?? false;
        range.text(`${enabled ? "☑️" : "☐"} ${event}`, async (menuCtx) => {
          if (!(await requireChatAdminCallback(menuCtx))) {
            return;
          }

          toggleEvent(menuCtx, event);
          menuCtx.menu.update();
        });
      }
      range.row();
    }

    return range;
  })
  .submenu(
    (ctx) => {
      const key = menuKeyFromContext(ctx);
      const state = key === null ? null : getSelectedSubscription(key);

      return formatRepoSelectionLabel(state?.selectedRepos ?? null);
    },
    reposMenuId,
    async (ctx) => {
      if (!(await requireChatAdminCallback(ctx))) {
        return;
      }

      await ctx.editMessageText("Repos");
    }
  )
  .row()
  .text(
    (ctx) => {
      const key = menuKeyFromContext(ctx);
      const draft = key === null ? null : getFilterDraft(key);

      return `🤖 Ignore bot authors: ${draft?.filters.ignoreBotAuthors === false ? "❌" : "✅"}`;
    },
    async (ctx) => {
      if (!(await requireChatAdminCallback(ctx))) {
        return;
      }

      const key = menuKeyFromContext(ctx);

      if (key !== null) {
        const draft = getFilterDraft(key);
        setFilterDraft(key, {
          preset: "custom",
          filters: {
            ...draft.filters,
            ignoreBotAuthors: !draft.filters.ignoreBotAuthors
          }
        });
        updateSelectedSubscription(key, { preset: "custom" });
      }

      ctx.menu.update();
    }
  )
  .row()
  .text("💾 Save", async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    await saveFilters(ctx);
  })
  .text("🔄 Reset to preset", async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    const key = menuKeyFromContext(ctx);

    if (key !== null) {
      const draft = getFilterDraft(key);
      const preset = draft.preset === "custom" ? "firehose" : draft.preset;
      setFilterDraft(key, {
        preset,
        filters: clonePresetFilters(preset)
      });
    }

    ctx.menu.update();
  })
  .text("❌ Cancel", async (ctx) => {
    const key = menuKeyFromContext(ctx);

    if (key !== null) {
      clearFilterDraft(key);
    }

    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  });

export const createFilterEventRange = (): MenuRange<Context> =>
  new MenuRange<Context>().dynamic((ctx, range) => {
    for (const event of filterEventValues) {
      range.text(event, () => undefined);
    }

    return range;
  });
