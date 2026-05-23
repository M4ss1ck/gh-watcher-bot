// Applies saved subscription filters to collected GitHub events.
import type { FilterEvent, GitHubEventPayload, SubscriptionFilters } from "~/db/schema";
import type { StoredEvent } from "~/github/types";
import { matchesGlobRules } from "~/filters/glob";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const pullRequestActionToFilter: Record<string, FilterEvent> = {
  opened: "pull_request_opened",
  closed: "pull_request_closed",
  merged: "pull_request_merged",
  reopened: "pull_request_reopened"
};

const issueActionToFilter: Record<string, FilterEvent> = {
  opened: "issue_opened",
  closed: "issue_closed",
  reopened: "issue_reopened"
};

const createRefTypeToFilter: Record<string, FilterEvent> = {
  branch: "branch_created",
  tag: "tag_created"
};

const getPayloadString = (
  payload: GitHubEventPayload,
  key: string
): string | null => {
  const value = payload[key];

  return typeof value === "string" ? value : null;
};

export const getFilterEventType = (event: StoredEvent): FilterEvent | null => {
  switch (event.type) {
    case "PushEvent":
      return "push";
    case "PullRequestEvent": {
      const action = getPayloadString(event.payload, "action");
      return action === null ? null : pullRequestActionToFilter[action] ?? null;
    }
    case "IssuesEvent": {
      const action = getPayloadString(event.payload, "action");
      return action === null ? null : issueActionToFilter[action] ?? null;
    }
    case "ReleaseEvent":
      return "release";
    case "RepositoryEvent":
      return "repository";
    case "ForkEvent":
      return "fork";
    case "WatchEvent":
      return "star";
    case "CreateEvent": {
      const refType = getPayloadString(event.payload, "ref_type");
      return refType === null ? null : createRefTypeToFilter[refType] ?? null;
    }
    default:
      return null;
  }
};

const isBotAuthor = (login: string): boolean =>
  /\[bot\]$/i.test(login) || /-bot$/i.test(login);

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
  const ref = getPayloadString(event.payload, "ref");

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
