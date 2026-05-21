// Verifies preset picker labels and available saved presets.
import { describe, expect, test } from "bun:test";

import {
  formatPresetOptionLabel,
  savePresetSelection,
  selectableSubscriptionPresets
} from "~/bot/menus/preset";
import {
  getSelectedSubscription,
  setFilterDraft,
  setPresetDraft,
  setSelectedSubscription
} from "~/bot/menus/state";
import { clonePresetFilters } from "~/filters/presets";

describe("subscription preset menu helpers", () => {
  test("lists saved presets without custom", () => {
    expect(selectableSubscriptionPresets).toEqual([
      "firehose",
      "releases_only",
      "prs_and_releases",
      "code_activity",
      "new_stuff"
    ]);
  });

  test("formats selected and unselected preset options", () => {
    expect(formatPresetOptionLabel("code_activity", "code_activity")).toBe(
      "◉ code_activity"
    );
    expect(formatPresetOptionLabel("firehose", "releases_only")).toBe(
      "○ releases_only"
    );
  });

  test("saves a selected preset with its preset filters", async () => {
    const key = { chatId: 123, userId: 456 };
    const updates: unknown[] = [];
    let syncCount = 0;

    setSelectedSubscription(key, {
      id: 91,
      accountId: 583231,
      accountLogin: "octocat",
      preset: "firehose",
      schedulePreset: "hourly",
      timezone: "UTC",
      selectedRepos: null,
      paused: false,
      lastDeliveredAt: null
    });
    setPresetDraft(key, "releases_only");
    setFilterDraft(key, {
      preset: "custom",
      filters: clonePresetFilters("firehose")
    });

    await savePresetSelection({
      subscriptionId: 91,
      key,
      preset: "releases_only",
      updateFilters: async (id, filters, preset) => {
        updates.push({ id, filters, preset });
      },
      sync: async () => {
        syncCount += 1;
      }
    });

    expect(updates).toEqual([
      {
        id: 91,
        filters: clonePresetFilters("releases_only"),
        preset: "releases_only"
      }
    ]);
    expect(getSelectedSubscription(key)?.preset).toBe("releases_only");
    expect(syncCount).toBe(1);
  });
});
