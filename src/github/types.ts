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
