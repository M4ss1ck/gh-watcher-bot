// Verifies subscription menu text helpers and button styling.
import { describe, expect, test } from "bun:test";

import { applyMenuButtonStyles } from "~/bot/menus/root";
import {
  buildSubscriptionMenuTextFromState,
  buildRootMenuText,
  formatSubscriptionListButton
} from "~/bot/menus/root";
import type { SubscriptionListItem } from "~/db/queries";
import { filterPresets } from "~/filters/presets";

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
        filters: filterPresets.releases_only,
        schedulePreset: "daily_09",
        timezone: "UTC",
        selectedRepos: null,
        paused: false,
        lastDeliveredAt: null
      } satisfies SubscriptionListItem)
    ).toBe("▶️ @torvalds · Releases only, Daily 09:00");
  });

  test("builds root header text", () => {
    expect(buildRootMenuText()).toBe("Subscriptions in this chat");
  });

  test("formats subscription detail text for humans", () => {
    expect(
      buildSubscriptionMenuTextFromState({
        id: 10,
        accountId: 1026,
        accountLogin: "torvalds",
        preset: "prs_and_releases",
        filters: filterPresets.prs_and_releases,
        schedulePreset: "as_fetched",
        timezone: "America/Santiago",
        selectedRepos: null,
        paused: false,
        lastDeliveredAt: new Date("2026-05-20T12:30:00Z")
      })
    ).toBe(
      [
        "<code>@torvalds</code>",
        "Preset: Pull requests and releases",
        "Schedule: As fetched",
        "Timezone: America/Santiago",
        "Repos: all repos",
        "Status: active",
        "Last delivery: 2026-05-20 08:30 America/Santiago"
      ].join("\n")
    );
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
