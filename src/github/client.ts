// Creates the Octokit client with retry and throttling plugins.
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";

import {
  parseGitHubPublicEvents,
  parseGitHubUserSummary,
  type GitHubPublicEvent,
  type GitHubUserSummary
} from "~/github/types";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

const OctokitWithPlugins = Octokit.plugin(retry, throttling);

export type GitHubEventsResponse = {
  status: 200;
  headers: {
    etag?: string;
  };
  data: GitHubPublicEvent[];
};

export type GitHubApiClient = {
  fetchUserEvents: (input: {
    login: string;
    etag: string | null;
  }) => Promise<GitHubEventsResponse>;
  getUser: (login: string) => Promise<GitHubUserSummary>;
};

export const createGitHubClient = (): GitHubApiClient => {
  const octokit = new OctokitWithPlugins({
    auth: env.GITHUB_TOKEN || undefined,
    throttle: {
      onRateLimit: (retryAfter, options) => {
        logger.warn(
          { retry_after_seconds: retryAfter, method: options.method, url: options.url },
          "github rate limit reached"
        );
      },
      onSecondaryRateLimit: (retryAfter, options) => {
        logger.warn(
          { retry_after_seconds: retryAfter, method: options.method, url: options.url },
          "github secondary rate limit reached"
        );
      }
    }
  });

  return {
    fetchUserEvents: async ({ login, etag }) => {
      const response = await octokit.request("GET /users/{username}/events", {
        username: login,
        headers: etag === null ? undefined : { "If-None-Match": etag }
      });

      return {
        status: 200,
        headers: {
          etag:
            typeof response.headers.etag === "string"
              ? response.headers.etag
              : undefined
        },
        data: parseGitHubPublicEvents(response.data)
      };
    },
    getUser: async (login) => {
      const response = await octokit.request("GET /users/{username}", {
        username: login
      });

      return parseGitHubUserSummary(response.data);
    }
  };
};
