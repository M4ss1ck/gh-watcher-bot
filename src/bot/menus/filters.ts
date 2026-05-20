// Defines the filter editor menu for subscription drafts.
import { Menu, MenuRange } from "@grammyjs/menu";
import type { Context } from "grammy";

import { filterEventValues, type FilterEvent } from "~/db/schema";
import { clonePresetFilters } from "~/filters/presets";
import { filtersMenuId, subscriptionMenuId } from "~/bot/menus/ids";
import {
  buildSubscriptionMenuText,
  subscriptionMenu
} from "~/bot/menus/subscription";
import { menuKeyFromContext } from "~/bot/menus/root";
import {
  clearFilterDraft,
  getFilterDraft,
  setFilterDraft,
  updateSelectedSubscription
} from "~/bot/menus/state";

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

export const buildFiltersHeaderText = (): string => "Filters";

export const filtersMenu = new Menu<Context>(filtersMenuId)
  .dynamic((ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const draft = key === null ? null : getFilterDraft(key);

    for (const row of eventRows) {
      for (const event of row) {
        const enabled = draft?.filters.events.includes(event) ?? false;
        range.text(`${enabled ? "☑️" : "☐"} ${event}`, async (menuCtx) => {
          toggleEvent(menuCtx, event);
          menuCtx.menu.update();
        });
      }
      range.row();
    }

    return range;
  })
  .text("📁 Repos: all", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Repo refine is not wired yet." });
  })
  .row()
  .text(
    (ctx) => {
      const key = menuKeyFromContext(ctx);
      const draft = key === null ? null : getFilterDraft(key);

      return `🤖 Ignore bot authors: ${draft?.filters.ignoreBotAuthors === false ? "☐" : "☑️"}`;
    },
    (ctx) => {
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
    const key = menuKeyFromContext(ctx);

    if (key !== null) {
      clearFilterDraft(key);
    }

    await ctx.editMessageText(buildSubscriptionMenuText(ctx), {
      reply_markup: subscriptionMenu
    });
  })
  .text("🔄 Reset to preset", (ctx) => {
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
