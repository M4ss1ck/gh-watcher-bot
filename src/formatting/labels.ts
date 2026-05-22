// Maps stored enum values to user-facing labels.
import type { SchedulePreset, SubscriptionPreset } from "~/db/schema";

const schedulePresetLabels: Record<SchedulePreset, string> = {
  as_fetched: "As fetched",
  hourly: "Hourly",
  every_6h: "Every 6 hours",
  daily_09: "Daily 09:00",
  daily_18: "Daily 18:00",
  weekly_mon_09: "Weekly Monday 09:00"
};

const subscriptionPresetLabels: Record<SubscriptionPreset, string> = {
  firehose: "Firehose",
  releases_only: "Releases only",
  prs_and_releases: "Pull requests and releases",
  code_activity: "Code activity",
  new_stuff: "New stuff",
  custom: "Custom"
};

export const formatSchedulePresetLabel = (preset: SchedulePreset): string =>
  schedulePresetLabels[preset];

export const formatSubscriptionPresetLabel = (
  preset: SubscriptionPreset
): string => subscriptionPresetLabels[preset];
