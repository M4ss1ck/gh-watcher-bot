// Defines the root subscription menu for the current chat.
import { Menu, MenuRange } from "@grammyjs/menu";
import type { Context, Transformer } from "grammy";

import type { SubscriptionListItem } from "~/db/queries";
import { formatDateTimeInTimeZone } from "~/formatting/dates";
import {
  formatSchedulePresetLabel,
  formatSubscriptionPresetLabel
} from "~/formatting/labels";
import { escapeHtml } from "~/formatting/render";
import { rootMenuId, subscriptionMenuId } from "~/bot/menus/ids";
import {
  setSelectedSubscription,
  type MenuKey,
  type SubscriptionMenuState
} from "~/bot/menus/state";
import { channelPostUserId, textInputs } from "~/bot/menus/textInput";

type StyledButton = {
  text?: unknown;
  style?: "danger" | "success" | "primary";
};

const primaryButtonLabels = new Set([
  "➕ Add new subscription",
  "👁 Preview now"
]);
const successButtonLabels = new Set(["💾 Save", "▶️ Resume"]);
const dangerButtonLabels = new Set([
  "🗑 Delete",
  "🗑 Confirm delete",
  "📣 Send broadcast"
]);

export const buildRootMenuText = (): string => "Subscriptions in this chat";

export const formatSubscriptionListButton = (
  item: SubscriptionListItem
): string => {
  const status = item.paused ? "⏸" : "▶️";
  const paused = item.paused ? " (paused)" : "";

  return `${status} @${item.accountLogin} · ${formatSubscriptionPresetLabel(item.preset)}, ${formatSchedulePresetLabel(item.schedulePreset)}${paused}`;
};

export const menuKeyFromContext = (ctx: Context): MenuKey | null => {
  if (ctx.chat === undefined || ctx.from === undefined) {
    return null;
  }

  return {
    chatId: ctx.chat.id,
    userId: ctx.from.id
  };
};

const setSelectionFromListItem = (ctx: Context, item: SubscriptionListItem): void => {
  const key = menuKeyFromContext(ctx);

  if (key === null) {
    return;
  }

  const state = {
    id: item.id,
    accountId: item.accountId,
    accountLogin: item.accountLogin,
    preset: item.preset,
    schedulePreset: item.schedulePreset,
    timezone: item.timezone,
    selectedRepos: item.selectedRepos,
    paused: item.paused,
    lastDeliveredAt: item.lastDeliveredAt
  };

  setSelectedSubscription(key, state);

  if (ctx.chat?.type === "channel") {
    setSelectedSubscription(
      {
        chatId: key.chatId,
        userId: channelPostUserId
      },
      state
    );
  }
};

export const applyMenuButtonStyles = (payload: unknown): void => {
  if (typeof payload !== "object" || payload === null || !("reply_markup" in payload)) {
    return;
  }

  const replyMarkup = payload.reply_markup;

  if (
    typeof replyMarkup !== "object" ||
    replyMarkup === null ||
    !("inline_keyboard" in replyMarkup) ||
    !Array.isArray(replyMarkup.inline_keyboard)
  ) {
    return;
  }

  for (const row of replyMarkup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }

    for (const button of row as StyledButton[]) {
      if (typeof button.text !== "string") {
        continue;
      }

      if (primaryButtonLabels.has(button.text)) {
        button.style = "primary";
      } else if (successButtonLabels.has(button.text)) {
        button.style = "success";
      } else if (dangerButtonLabels.has(button.text)) {
        button.style = "danger";
      }
    }
  }
};

export const menuButtonStyleTransformer: Transformer = (
  previous,
  method,
  payload,
  signal
) => {
  applyMenuButtonStyles(payload);

  return previous(method, payload, signal);
};

const loadSubscriptions = async (
  chatId: number
): Promise<SubscriptionListItem[]> => {
  const queries = await import("~/db/queries");

  return queries.listSubscriptionsForChat(chatId);
};

export const rootMenu = new Menu<Context>(rootMenuId)
  .dynamic(async (ctx, range) => {
    if (ctx.chat === undefined) {
      return range;
    }

    const subscriptions = await loadSubscriptions(ctx.chat.id);

    for (const item of subscriptions) {
      range
        .submenu(formatSubscriptionListButton(item), subscriptionMenuId, async (menuCtx) => {
          setSelectionFromListItem(menuCtx, item);
          await menuCtx.editMessageText(buildSubscriptionMenuTextFromState({
            id: item.id,
            accountId: item.accountId,
            accountLogin: item.accountLogin,
            preset: item.preset,
            schedulePreset: item.schedulePreset,
            timezone: item.timezone,
            selectedRepos: item.selectedRepos,
            paused: item.paused,
            lastDeliveredAt: item.lastDeliveredAt
          }));
        })
        .row();
    }

    return range;
  })
  .text("➕ Add new subscription", async (ctx) => {
    const key = menuKeyFromContext(ctx);

    if (key === null) {
      await ctx.answerCallbackQuery({ text: "Open this from a chat." });
      return;
    }

    textInputs.set(key, { waitingFor: "username" });
    if (ctx.chat?.type === "channel") {
      textInputs.set(
        {
          chatId: key.chatId,
          userId: channelPostUserId
        },
        { waitingFor: "username" }
      );
    }
    await ctx.reply("Send the GitHub username to watch within 60 seconds.");
  });

export const buildSubscriptionMenuTextFromState = (
  state: SubscriptionMenuState
): string => [
  `<code>@${escapeHtml(state.accountLogin)}</code>`,
  `Preset: ${formatSubscriptionPresetLabel(state.preset)}`,
  `Schedule: ${formatSchedulePresetLabel(state.schedulePreset)}`,
  `Timezone: ${state.timezone}`,
  `Repos: ${state.selectedRepos === null ? "all repos" : `${state.selectedRepos.length} selected`}`,
  `Status: ${state.paused ? "paused" : "active"}`,
  `Last delivery: ${state.lastDeliveredAt === null ? "never" : formatDateTimeInTimeZone(state.lastDeliveredAt, state.timezone)}`
].join("\n");

export const createStaticRange = (): MenuRange<Context> => new MenuRange<Context>();
