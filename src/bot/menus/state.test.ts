// Verifies that menu drafts load the actual saved subscription state.
import { afterEach, describe, expect, test } from "bun:test";

import {
  clearFilterDraft,
  clearScheduleDraft,
  clearSelectedSubscription,
  getFilterDraft,
  getScheduleDraft,
  setSelectedSubscription,
  type SubscriptionMenuState
} from "~/bot/menus/state";
import { clonePresetFilters } from "~/filters/presets";

const key = { chatId: 555, userId: 666 };

const baseState = (overrides: Partial<SubscriptionMenuState> = {}): SubscriptionMenuState => ({
  id: 1,
  accountId: 2,
  accountLogin: "octocat",
  preset: "firehose",
  filters: clonePresetFilters("firehose"),
  schedulePreset: "hourly",
  timezone: "UTC",
  selectedRepos: null,
  paused: false,
  aiSummary: false,
  lastDeliveredAt: null,
  ...overrides
});

describe("menu state drafts", () => {
  afterEach(() => {
    clearSelectedSubscription(key);
    clearFilterDraft(key);
    clearScheduleDraft(key);
  });

  test("filter draft seeds from the saved subscription filters, not the preset", () => {
    const savedFilters = {
      ...clonePresetFilters("releases_only"),
      events: ["release"] as const
    };

    setSelectedSubscription(
      key,
      baseState({
        preset: "custom",
        filters: { ...savedFilters, events: [...savedFilters.events] }
      })
    );

    const draft = getFilterDraft(key);
    expect(draft.preset).toBe("custom");
    expect(draft.filters.events).toEqual(["release"]);
  });

  test("filter draft falls back to firehose when no subscription is selected", () => {
    const draft = getFilterDraft(key);
    expect(draft.preset).toBe("firehose");
    expect(draft.filters).toEqual(clonePresetFilters("firehose"));
  });

  test("schedule draft seeds from the saved schedule preset", () => {
    setSelectedSubscription(key, baseState({ schedulePreset: "as_fetched" }));
    expect(getScheduleDraft(key)).toBe("as_fetched");
  });
});
