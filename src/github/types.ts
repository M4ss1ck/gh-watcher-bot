// Defines narrow GitHub event payload types used by the bot.
export type GitHubEventPayload = Record<string, unknown>;

export type GitHubPublicEvent = {
  id: string;
  type: string;
  repo: {
    name: string;
  };
  actor: {
    login: string;
  };
  payload: GitHubEventPayload;
  created_at: string;
};

export type GitHubUserSummary = {
  id: number;
  login: string;
  name: string | null;
  bio: string | null;
  publicRepos: number;
  followers: number;
  htmlUrl: string;
};

export type GitHubRepoSummary = {
  id: number;
  name: string;
  fullName: string;
};

export type GitHubRepoListItem = GitHubRepoSummary;

export type GitHubPullRequestDetail = {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  merged: boolean;
  mergedBy: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
};

export type StoredEvent = {
  id: string;
  accountId: number;
  type: string;
  repoName: string;
  actorLogin: string;
  payload: GitHubEventPayload;
  createdAt: Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGitHubPublicEvent = (value: unknown): value is GitHubPublicEvent => {
  if (!isRecord(value)) {
    return false;
  }

  const repo = value.repo;
  const actor = value.actor;

  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    isRecord(repo) &&
    typeof repo.name === "string" &&
    isRecord(actor) &&
    typeof actor.login === "string" &&
    isRecord(value.payload) &&
    typeof value.created_at === "string"
  );
};

export const parseGitHubPublicEvents = (
  value: unknown
): GitHubPublicEvent[] => {
  if (!Array.isArray(value)) {
    throw new Error("GitHub events response was not an array");
  }

  return value.filter(isGitHubPublicEvent);
};

export const parseGitHubUserSummary = (value: unknown): GitHubUserSummary => {
  if (!isRecord(value)) {
    throw new Error("GitHub user response was not an object");
  }

  if (
    typeof value.id !== "number" ||
    typeof value.login !== "string" ||
    !(typeof value.name === "string" || value.name === null) ||
    !(typeof value.bio === "string" || value.bio === null) ||
    typeof value.public_repos !== "number" ||
    typeof value.followers !== "number" ||
    typeof value.html_url !== "string"
  ) {
    throw new Error("GitHub user response did not include required summary fields");
  }

  return {
    id: value.id,
    login: value.login,
    name: value.name,
    bio: value.bio,
    publicRepos: value.public_repos,
    followers: value.followers,
    htmlUrl: value.html_url
  };
};

export const parseGitHubRepoSummary = (value: unknown): GitHubRepoSummary => {
  if (!isRecord(value)) {
    throw new Error("GitHub repo response was not an object");
  }

  if (
    typeof value.id !== "number" ||
    typeof value.name !== "string" ||
    typeof value.full_name !== "string"
  ) {
    throw new Error("GitHub repo response did not include required summary fields");
  }

  return {
    id: value.id,
    name: value.name,
    fullName: value.full_name
  };
};

export const parseGitHubRepoList = (value: unknown): GitHubRepoListItem[] => {
  if (!Array.isArray(value)) {
    throw new Error("GitHub repos response was not an array");
  }

  return value.map(parseGitHubRepoSummary);
};

export const parseGitHubPullRequestDetail = (
  value: unknown
): GitHubPullRequestDetail => {
  if (!isRecord(value)) {
    throw new Error("GitHub pull request response was not an object");
  }

  if (
    typeof value.number !== "number" ||
    typeof value.title !== "string" ||
    !(typeof value.body === "string" || value.body === null) ||
    typeof value.html_url !== "string" ||
    typeof value.merged !== "boolean" ||
    typeof value.additions !== "number" ||
    typeof value.deletions !== "number" ||
    typeof value.changed_files !== "number" ||
    typeof value.commits !== "number"
  ) {
    throw new Error("GitHub pull request response did not include required fields");
  }

  const mergedBy = isRecord(value.merged_by) && typeof value.merged_by.login === "string"
    ? value.merged_by.login
    : null;

  return {
    number: value.number,
    title: value.title,
    body: value.body,
    htmlUrl: value.html_url,
    merged: value.merged,
    mergedBy,
    additions: value.additions,
    deletions: value.deletions,
    changedFiles: value.changed_files,
    commits: value.commits
  };
};
