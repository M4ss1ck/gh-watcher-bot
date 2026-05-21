// Verifies subscription menu text helpers and button styling.
import { describe, expect, test } from "bun:test";

import { applyMenuButtonStyles } from "~/bot/menus/root";
import {
  buildRootMenuText,
  formatSubscriptionListButton
} from "~/bot/menus/root";
import type { SubscriptionListItem } from "~/db/queries";

type StyledButton = {
  text: string;
  style?: "primary" | "success" | "danger";
};

describe("subscription root menu helpers", () => {
  test("formats existing subscription rows", () => {
    expect(
      formatSubscriptionListButton({
        id: 10,
        accountId: 1026,
        accountLogin: "torvalds",
        preset: "releases_only",
        schedulePreset: "daily_09",
        timezone: "UTC",
        selectedRepos: null,
        paused: false,
        lastDeliveredAt: null
      } satisfies SubscriptionListItem)
    ).toBe("▶️ @torvalds · releases_only, daily_09");
  });

  test("builds root header text", () => {
    expect(buildRootMenuText()).toBe("Subscriptions in this chat");
  });

  test("applies Bot API button styles to known labels", () => {
    const payload: {
      reply_markup: {
        inline_keyboard: StyledButton[][];
      };
    } = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Add new subscription" }],
          [{ text: "💾 Save" }, { text: "🗑 Delete" }]
        ]
      }
    };

    applyMenuButtonStyles(payload);

    expect(payload.reply_markup.inline_keyboard).toEqual([
      [{ text: "➕ Add new subscription", style: "primary" }],
      [
        { text: "💾 Save", style: "success" },
        { text: "🗑 Delete", style: "danger" }
      ]
    ]);
  });
});
