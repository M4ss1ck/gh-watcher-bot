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
  id: number;
  accountId: number;
  accountLogin: string;
  preset: SubscriptionPreset;
  filters: SubscriptionFilters;
  schedulePreset: SchedulePreset;
  timezone: string;
  selectedRepos: string[] | null;
  paused: boolean;
  aiSummary: boolean;
  lastDeliveredAt: Date | null;
};

export type FilterDraft = {
  preset: SubscriptionPreset;
  filters: SubscriptionFilters;
};

export type SavedSubscriptionPreset = Exclude<SubscriptionPreset, "custom">;

const selections = new Map<string, SubscriptionMenuState>();
const filterDrafts = new Map<string, FilterDraft>();
const presetDrafts = new Map<string, SavedSubscriptionPreset>();
const repoDrafts = new Map<string, string[] | null>();
const scheduleDrafts = new Map<string, SchedulePreset>();

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

export const clearSelectedSubscription = (key: MenuKey): void => {
  selections.delete(menuKey(key));
  filterDrafts.delete(menuKey(key));
  presetDrafts.delete(menuKey(key));
  repoDrafts.delete(menuKey(key));
  scheduleDrafts.delete(menuKey(key));
};

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

export const getFilterDraft = (key: MenuKey): FilterDraft => {
  const id = menuKey(key);
  const existing = filterDrafts.get(id);

  if (existing !== undefined) {
    return existing;
  }

  const selection = getSelectedSubscription(key);

  if (selection !== null) {
    const draft = {
      preset: selection.preset,
      filters: structuredClone(selection.filters)
    };

    filterDrafts.set(id, draft);

    return draft;
  }

  const draft = {
    preset: "firehose" as const,
    filters: clonePresetFilters("firehose")
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

export const getPresetDraft = (key: MenuKey): SavedSubscriptionPreset => {
  const id = menuKey(key);
  const existing = presetDrafts.get(id);

  if (existing !== undefined) {
    return existing;
  }

  const selection = getSelectedSubscription(key);
  const preset =
    selection === null || selection.preset === "custom" ? "firehose" : selection.preset;
  presetDrafts.set(id, preset);

  return preset;
};

export const setPresetDraft = (
  key: MenuKey,
  preset: SavedSubscriptionPreset
): void => {
  presetDrafts.set(menuKey(key), preset);
};

export const clearPresetDraft = (key: MenuKey): void => {
  presetDrafts.delete(menuKey(key));
};

export const getRepoDraft = (key: MenuKey): string[] | null => {
  const id = menuKey(key);

  if (repoDrafts.has(id)) {
    return repoDrafts.get(id) ?? null;
  }

  const selected = getSelectedSubscription(key)?.selectedRepos ?? null;
  const draft = selected === null ? null : [...selected];
  repoDrafts.set(id, draft);

  return draft;
};

export const setRepoDraft = (key: MenuKey, selectedRepos: string[] | null): void => {
  repoDrafts.set(menuKey(key), selectedRepos === null ? null : [...selectedRepos]);
};

export const clearRepoDraft = (key: MenuKey): void => {
  repoDrafts.delete(menuKey(key));
};

export const getScheduleDraft = (key: MenuKey): SchedulePreset | null => {
  const id = menuKey(key);
  const existing = scheduleDrafts.get(id);

  if (existing !== undefined) {
    return existing;
  }

  const selection = getSelectedSubscription(key);

  if (selection === null) {
    return null;
  }

  scheduleDrafts.set(id, selection.schedulePreset);

  return selection.schedulePreset;
};

export const setScheduleDraft = (key: MenuKey, preset: SchedulePreset): void => {
  scheduleDrafts.set(menuKey(key), preset);
};

export const clearScheduleDraft = (key: MenuKey): void => {
  scheduleDrafts.delete(menuKey(key));
};
