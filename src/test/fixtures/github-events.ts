// Provides handwritten GitHub event fixtures for filter and formatter tests.
import type { StoredEvent } from "~/github/types";

export const pushEvent: StoredEvent = {
  id: "push-1",
  accountId: 1,
  type: "PushEvent",
  repoName: "octocat/hello-world",
  actorLogin: "octocat",
  payload: {
    ref: "refs/heads/main",
    size: 2,
    commits: [
      {
        sha: "abc123456789",
        message: "Fix parser <edge>",
        url: "https://github.com/octocat/hello-world/commit/abc123456789"
      },
      {
        sha: "def123456789",
        message: "Add tests & docs",
        url: "https://github.com/octocat/hello-world/commit/def123456789"
      }
    ]
  },
  createdAt: new Date("2026-05-20T12:00:00Z")
};

export const pullRequestEvent: StoredEvent = {
  id: "pr-1",
  accountId: 1,
  type: "PullRequestEvent",
  repoName: "octocat/hello-world",
  actorLogin: "octocat",
  payload: {
    action: "opened",
    pull_request: {
      number: 42,
      title: "Improve summary",
      html_url: "https://github.com/octocat/hello-world/pull/42",
      head: {
        ref: "feature/summary"
      },
      base: {
        ref: "main"
      }
    }
  },
  createdAt: new Date("2026-05-20T12:05:00Z")
};

export const releaseEvent: StoredEvent = {
  id: "release-1",
  accountId: 1,
  type: "ReleaseEvent",
  repoName: "octocat/hello-world",
  actorLogin: "release-bot[bot]",
  payload: {
    action: "published",
    release: {
      tag_name: "v1.2.3",
      name: "Version <1.2.3>",
      html_url: "https://github.com/octocat/hello-world/releases/tag/v1.2.3"
    }
  },
  createdAt: new Date("2026-05-20T12:10:00Z")
};

export const starEvent: StoredEvent = {
  id: "star-1",
  accountId: 1,
  type: "WatchEvent",
  repoName: "octocat/hello-world",
  actorLogin: "friend",
  payload: {
    action: "started"
  },
  createdAt: new Date("2026-05-20T12:15:00Z")
};

export const forkEvent: StoredEvent = {
  id: "fork-1",
  accountId: 1,
  type: "ForkEvent",
  repoName: "octocat/hello-world",
  actorLogin: "friend",
  payload: {
    forkee: {
      full_name: "friend/hello-world"
    }
  },
  createdAt: new Date("2026-05-20T12:20:00Z")
};

export const createEvent: StoredEvent = {
  id: "create-1",
  accountId: 1,
  type: "CreateEvent",
  repoName: "octocat/hello-world",
  actorLogin: "octocat",
  payload: {
    ref_type: "branch",
    ref: "develop"
  },
  createdAt: new Date("2026-05-20T12:25:00Z")
};

export const fixtureEvents = [
  pushEvent,
  pullRequestEvent,
  releaseEvent,
  starEvent,
  forkEvent,
  createEvent
];
