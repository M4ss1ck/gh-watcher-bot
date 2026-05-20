// Summarizes noisy event payloads before rendering.
import type { GitHubEventPayload } from "~/db/schema";
import type { StoredEvent } from "~/github/types";
import { normalizeBranchName } from "~/filters/apply";

export type EventSummary = {
  title: string;
  detail: string | null;
  url: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getString = (payload: GitHubEventPayload, key: string): string | null => {
  const value = payload[key];

  return typeof value === "string" ? value : null;
};

const getRecord = (
  payload: Record<string, unknown>,
  key: string
): Record<string, unknown> | null => {
  const value = payload[key];

  return isRecord(value) ? value : null;
};

const getRecordString = (
  payload: Record<string, unknown>,
  key: string
): string | null => {
  const value = payload[key];

  return typeof value === "string" ? value : null;
};

const firstCommitUrl = (payload: GitHubEventPayload): string | null => {
  const commits = payload.commits;

  if (!Array.isArray(commits)) {
    return null;
  }

  const first = commits[0];

  return isRecord(first) ? getRecordString(first, "url") : null;
};

const pushDetail = (payload: GitHubEventPayload): string | null => {
  const commits = payload.commits;

  if (!Array.isArray(commits)) {
    return null;
  }

  const messages = commits
    .map((commit) =>
      isRecord(commit) ? getRecordString(commit, "message") : null
    )
    .filter((message): message is string => message !== null)
    .slice(0, 3);

  if (messages.length === 0) {
    return null;
  }

  const suffix = commits.length > messages.length ? `; +${commits.length - messages.length} more` : "";

  return `${messages.join("; ")}${suffix}`;
};

const pushSummary = (event: StoredEvent): EventSummary => {
  const ref = getString(event.payload, "ref");
  const branch = ref === null ? "unknown" : normalizeBranchName(ref);
  const size = event.payload.size;
  const commitCount =
    typeof size === "number"
      ? size
      : Array.isArray(event.payload.commits)
        ? event.payload.commits.length
        : 0;
  const noun = commitCount === 1 ? "commit" : "commits";

  return {
    title: `pushed ${commitCount} ${noun} to ${branch}`,
    detail: pushDetail(event.payload),
    url: firstCommitUrl(event.payload)
  };
};

const pullRequestSummary = (event: StoredEvent): EventSummary => {
  const pullRequest = event.payload.pull_request;
  const record = isRecord(pullRequest) ? pullRequest : {};
  const action = getString(event.payload, "action") ?? "updated";
  const number = record.number;
  const title = getRecordString(record, "title") ?? "untitled";
  const url = getRecordString(record, "html_url");
  const label = typeof number === "number" ? `#${number}` : title;

  return {
    title: `${action} pull request ${label}`,
    detail: typeof number === "number" ? title : null,
    url
  };
};

const releaseSummary = (event: StoredEvent): EventSummary => {
  const release = event.payload.release;
  const record = isRecord(release) ? release : {};
  const action = getString(event.payload, "action") ?? "updated";
  const name =
    getRecordString(record, "name") ??
    getRecordString(record, "tag_name") ??
    "release";

  return {
    title: `${action} release ${name}`,
    detail: null,
    url: getRecordString(record, "html_url")
  };
};

const issuesSummary = (event: StoredEvent): EventSummary => {
  const issue = event.payload.issue;
  const record = isRecord(issue) ? issue : {};
  const action = getString(event.payload, "action") ?? "updated";
  const number = record.number;
  const title = getRecordString(record, "title") ?? "issue";

  return {
    title: `${action} issue ${typeof number === "number" ? `#${number}` : title}`,
    detail: typeof number === "number" ? title : null,
    url: getRecordString(record, "html_url")
  };
};

const createSummary = (event: StoredEvent): EventSummary => {
  const refType = getString(event.payload, "ref_type") ?? "ref";
  const ref = getString(event.payload, "ref");

  return {
    title: `created ${refType}${ref === null ? "" : ` ${ref}`}`,
    detail: null,
    url: null
  };
};

const forkSummary = (event: StoredEvent): EventSummary => {
  const forkee = getRecord(event.payload, "forkee");
  const fullName = forkee === null ? null : getRecordString(forkee, "full_name");

  return {
    title: `forked repository${fullName === null ? "" : ` to ${fullName}`}`,
    detail: null,
    url: null
  };
};

export const summarizeEvent = (event: StoredEvent): EventSummary => {
  switch (event.type) {
    case "PushEvent":
      return pushSummary(event);
    case "PullRequestEvent":
      return pullRequestSummary(event);
    case "ReleaseEvent":
      return releaseSummary(event);
    case "IssuesEvent":
      return issuesSummary(event);
    case "WatchEvent":
      return {
        title: "starred repository",
        detail: null,
        url: null
      };
    case "ForkEvent":
      return forkSummary(event);
    case "CreateEvent":
      return createSummary(event);
    case "RepositoryEvent":
      return {
        title: `${getString(event.payload, "action") ?? "updated"} repository`,
        detail: null,
        url: null
      };
    default:
      return {
        title: event.type,
        detail: null,
        url: null
      };
  }
};
