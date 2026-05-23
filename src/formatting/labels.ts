// Maps stored enum values to user-facing labels.
import type { FilterEvent, SchedulePreset, SubscriptionPreset } from "~/db/schema";

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

const filterEventLabels: Record<FilterEvent, string> = {
  push: "Push",
  pull_request_opened: "PR opened",
  pull_request_closed: "PR closed",
  pull_request_merged: "PR merged",
  pull_request_reopened: "PR reopened",
  issue_opened: "Issue opened",
  issue_closed: "Issue closed",
  issue_reopened: "Issue reopened",
  release: "Release",
  repository: "Repository",
  fork: "Fork",
  star: "Star",
  branch_created: "Branch created",
  tag_created: "Tag created"
};

export const formatSchedulePresetLabel = (preset: SchedulePreset): string =>
  schedulePresetLabels[preset];

export const formatSubscriptionPresetLabel = (
  preset: SubscriptionPreset
): string => subscriptionPresetLabels[preset];

export const formatFilterEventLabel = (event: FilterEvent): string =>
  filterEventLabels[event];
