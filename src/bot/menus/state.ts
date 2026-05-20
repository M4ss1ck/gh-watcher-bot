// Stores short-lived menu selection and draft state for interactive menus.
import { clonePresetFilters } from "~/filters/presets";
import type {
  SchedulePreset,
  SubscriptionFilters,
  SubscriptionPreset
} from "~/db/schema";

export type MenuKey = {
  chatId: number;
  userId: number;
};

export type SubscriptionMenuState = {
  id: number | null;
  accountLogin: string;
  preset: SubscriptionPreset;
  schedulePreset: SchedulePreset;
  timezone: string;
  paused: boolean;
  lastDeliveredAt: Date | null;
};

export type FilterDraft = {
  preset: SubscriptionPreset;
  filters: SubscriptionFilters;
};

const selections = new Map<string, SubscriptionMenuState>();
const filterDrafts = new Map<string, FilterDraft>();

export const menuKey = (key: MenuKey): string => `${key.chatId}:${key.userId}`;

export const setSelectedSubscription = (
  key: MenuKey,
  state: SubscriptionMenuState
): void => {
  selections.set(menuKey(key), state);
};

export const getSelectedSubscription = (
  key: MenuKey
): SubscriptionMenuState | null => selections.get(menuKey(key)) ?? null;

export const updateSelectedSubscription = (
  key: MenuKey,
  patch: Partial<SubscriptionMenuState>
): SubscriptionMenuState | null => {
  const current = getSelectedSubscription(key);

  if (current === null) {
    return null;
  }

  const next = { ...current, ...patch };
  setSelectedSubscription(key, next);

  return next;
};

export const createDraftSubscription = (
  accountLogin: string
): SubscriptionMenuState => ({
  id: null,
  accountLogin,
  preset: "firehose",
  schedulePreset: "hourly",
  timezone: "UTC",
  paused: false,
  lastDeliveredAt: null
});

export const getFilterDraft = (key: MenuKey): FilterDraft => {
  const id = menuKey(key);
  const existing = filterDrafts.get(id);

  if (existing !== undefined) {
    return existing;
  }

  const selection = getSelectedSubscription(key);
  const preset =
    selection === null || selection.preset === "custom" ? "firehose" : selection.preset;
  const draft = {
    preset,
    filters: clonePresetFilters(preset)
  };

  filterDrafts.set(id, draft);

  return draft;
};

export const setFilterDraft = (key: MenuKey, draft: FilterDraft): void => {
  filterDrafts.set(menuKey(key), draft);
};

export const clearFilterDraft = (key: MenuKey): void => {
  filterDrafts.delete(menuKey(key));
};
