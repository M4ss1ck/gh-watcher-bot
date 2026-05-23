// Defines saved filter presets for subscription setup.
import {
  filterEventValues,
  type SubscriptionFilters,
  type SubscriptionPreset
} from "~/db/schema";

const baseFilters = (events: SubscriptionFilters["events"]): SubscriptionFilters => ({
  events,
  repos: {
    include: ["*"],
    exclude: []
  },
  ignoreBotAuthors: true,
  minCommitsPerPush: 1,
  branches: {
    include: ["*"],
    exclude: []
  },
  enrichMergedPullRequests: false
});

const allPullRequestEvents = [
  "pull_request_opened",
  "pull_request_closed",
  "pull_request_merged",
  "pull_request_reopened"
] as const satisfies readonly SubscriptionFilters["events"][number][];

export const filterPresets = {
  firehose: {
    ...baseFilters([...filterEventValues]),
    ignoreBotAuthors: false
  },
  releases_only: baseFilters(["release"]),
  prs_and_releases: baseFilters([
    ...allPullRequestEvents,
    "release",
    "repository"
  ]),
  code_activity: {
    ...baseFilters(["push", ...allPullRequestEvents]),
    branches: {
      include: ["main", "master"],
      exclude: []
    },
    ignoreBotAuthors: true
  },
  new_stuff: baseFilters([
    "repository",
    "release",
    "fork",
    "star",
    "branch_created",
    "tag_created"
  ])
} satisfies Record<Exclude<SubscriptionPreset, "custom">, SubscriptionFilters>;

export const clonePresetFilters = (
  preset: Exclude<SubscriptionPreset, "custom">
): SubscriptionFilters => structuredClone(filterPresets[preset]);
