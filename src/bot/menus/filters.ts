// Defines the filter editor menu for subscription drafts.
import { Menu, MenuRange } from "@grammyjs/menu";
import type { Context } from "grammy";

import { filterEventValues, type FilterEvent } from "~/db/schema";
import { clonePresetFilters } from "~/filters/presets";
import { getDeliverer, getGitHubClient } from "~/bot/menus/deps";
import { filtersMenuId, subscriptionMenuId } from "~/bot/menus/ids";
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
  type MenuKey,
  type SubscriptionMenuState
} from "~/bot/menus/state";
import { textInputs } from "~/bot/menus/textInput";
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import {
  countSubscriptionsForChat,
  createOrUpdateSubscription,
  listSubscriptionsForChat,
  resolveOrCreateGitHubAccount,
  updateSubscriptionFilters
} from "~/db/queries";
import { env } from "~/lib/env";
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

const formatReposLabel = (state: { include: string[]; exclude: string[] } | null): string => {
  if (state === null || (state.include.length === 1 && state.include[0] === "*" && state.exclude.length === 0)) {
    return "📁 Repos: all";
  }

  const parts = [...state.include.map((value) => value), ...state.exclude.map((value) => `!${value}`)];
  const preview = parts.slice(0, 3).join(", ");

  return `📁 Repos: ${preview}${parts.length > 3 ? ", ..." : ""}`;
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

const persistNewSubscription = async (
  key: MenuKey,
  state: SubscriptionMenuState
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> => {
  const client = getGitHubClient();

  if (client === null) {
    return { ok: false, reason: "GitHub client unavailable. Try again later." };
  }

  const existing = await listSubscriptionsForChat(key.chatId);
  const account = await resolveOrCreateGitHubAccount(state.accountLogin, client);
  const alreadyHasAccount = existing.some((item) => item.accountLogin === account.login);

  if (!alreadyHasAccount && existing.length >= env.MAX_SUBS_PER_CHAT) {
    return {
      ok: false,
      reason: `This chat already has the maximum of ${env.MAX_SUBS_PER_CHAT} subscriptions.`
    };
  }

  const draft = getFilterDraft(key);
  const id = await createOrUpdateSubscription({
    chatId: key.chatId,
    accountId: account.id,
    preset: draft.preset,
    filters: draft.filters,
    schedulePreset: state.schedulePreset,
    timezone: state.timezone,
    createdByUserId: key.userId,
    lastDeliveredAt: null
  });

  return { ok: true, id };
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
    if (current.id !== null) {
      await updateSubscriptionFilters(current.id, draft.filters, draft.preset);
      updateSelectedSubscription(key, { preset: draft.preset });
    } else {
      const result = await persistNewSubscription(key, current);

      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: result.reason });
        return;
      }

      updateSelectedSubscription(key, { id: result.id, preset: draft.preset });
    }
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
  .text(
    (ctx) => {
      const key = menuKeyFromContext(ctx);
      const draft = key === null ? null : getFilterDraft(key);

      return formatReposLabel(draft?.filters.repos ?? null);
    },
    async (ctx) => {
      if (!(await requireChatAdminCallback(ctx))) {
        return;
      }

      const key = menuKeyFromContext(ctx);

      if (key === null) {
        return;
      }

      textInputs.set(key, { waitingFor: "repos" });
      await ctx.reply(
        "Send a comma-separated list of repo globs within 60 seconds. Prefix with ! to exclude. Send * to allow all."
      );
    }
  )
  .row()
  .text(
    (ctx) => {
      const key = menuKeyFromContext(ctx);
      const draft = key === null ? null : getFilterDraft(key);

      return `🤖 Ignore bot authors: ${draft?.filters.ignoreBotAuthors === false ? "☐" : "☑️"}`;
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

export const parseReposInput = (
  input: string
): { include: string[]; exclude: string[] } => {
  const tokens = input
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "*")) {
    return { include: ["*"], exclude: [] };
  }

  const include: string[] = [];
  const exclude: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("!")) {
      const value = token.slice(1).trim();
      if (value.length > 0) {
        exclude.push(value);
      }
    } else {
      include.push(token);
    }
  }

  return {
    include: include.length === 0 ? ["*"] : include,
    exclude
  };
};

export const applyReposInput = (
  key: MenuKey,
  input: string
): void => {
  const draft = getFilterDraft(key);
  const repos = parseReposInput(input);

  setFilterDraft(key, {
    preset: "custom",
    filters: {
      ...draft.filters,
      repos
    }
  });
  updateSelectedSubscription(key, { preset: "custom" });
};

export const createFilterEventRange = (): MenuRange<Context> =>
  new MenuRange<Context>().dynamic((ctx, range) => {
    for (const event of filterEventValues) {
      range.text(event, () => undefined);
    }

    return range;
  });
