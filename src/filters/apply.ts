// Applies saved subscription filters to collected GitHub events.
import type { FilterEvent, GitHubEventPayload, SubscriptionFilters } from "~/db/schema";
import type { StoredEvent } from "~/github/types";
import { matchesGlobRules } from "~/filters/glob";

const eventCategoryByGitHubType = new Map<string, FilterEvent>([
  ["PushEvent", "push"],
  ["PullRequestEvent", "pull_request"],
  ["IssuesEvent", "issues"],
  ["ReleaseEvent", "release"],
  ["RepositoryEvent", "repository"],
  ["ForkEvent", "fork"],
  ["WatchEvent", "star"],
  ["CreateEvent", "create"]
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const getFilterEventType = (event: StoredEvent): FilterEvent | null =>
  eventCategoryByGitHubType.get(event.type) ?? null;

const isBotAuthor = (login: string): boolean =>
  /\[bot\]$/i.test(login) || /-bot$/i.test(login);

const getString = (payload: GitHubEventPayload, key: string): string | null => {
  const value = payload[key];

  return typeof value === "string" ? value : null;
};

export const normalizeBranchName = (ref: string): string =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

const getPullRequestBranch = (
  payload: GitHubEventPayload,
  side: "head" | "base"
): string | null => {
  const pullRequest = payload.pull_request;

  if (!isRecord(pullRequest)) {
    return null;
  }

  const branch = pullRequest[side];

  if (!isRecord(branch)) {
    return null;
  }

  return typeof branch.ref === "string" ? branch.ref : null;
};

const getEventBranch = (event: StoredEvent): string | null => {
  const ref = getString(event.payload, "ref");

  if (ref !== null) {
    return normalizeBranchName(ref);
  }

  const pullRequestBranch = getPullRequestBranch(event.payload, "base");

  return pullRequestBranch === null ? null : normalizeBranchName(pullRequestBranch);
};

const getPushCommitCount = (payload: GitHubEventPayload): number => {
  const size = payload.size;

  if (typeof size === "number") {
    return size;
  }

  return Array.isArray(payload.commits) ? payload.commits.length : 0;
};

export const applyFilters = (
  filters: SubscriptionFilters,
  event: StoredEvent
): boolean => {
  const eventType = getFilterEventType(event);

  if (eventType === null || !filters.events.includes(eventType)) {
    return false;
  }

  if (filters.ignoreBotAuthors && isBotAuthor(event.actorLogin)) {
    return false;
  }

  if (!matchesGlobRules(event.repoName, filters.repos)) {
    return false;
  }

  const branch = getEventBranch(event);

  if (
    branch !== null &&
    !matchesGlobRules(branch, filters.branches)
  ) {
    return false;
  }

  if (
    eventType === "push" &&
    getPushCommitCount(event.payload) < filters.minCommitsPerPush
  ) {
    return false;
  }

  return true;
};
