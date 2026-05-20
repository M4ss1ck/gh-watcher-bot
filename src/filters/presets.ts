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
  }
});

export const filterPresets = {
  firehose: {
    ...baseFilters([...filterEventValues]),
    ignoreBotAuthors: false
  },
  releases_only: baseFilters(["release"]),
  prs_and_releases: baseFilters(["pull_request", "release", "repository"]),
  code_activity: {
    ...baseFilters(["push", "pull_request"]),
    branches: {
      include: ["main", "master"],
      exclude: []
    },
    ignoreBotAuthors: true
  },
  new_stuff: baseFilters(["repository", "release", "fork", "star", "create"])
} satisfies Record<Exclude<SubscriptionPreset, "custom">, SubscriptionFilters>;

export const clonePresetFilters = (
  preset: Exclude<SubscriptionPreset, "custom">
): SubscriptionFilters => structuredClone(filterPresets[preset]);
