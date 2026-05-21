// Verifies GitHub API response narrowing.
import { describe, expect, test } from "bun:test";

import { parseGitHubUserSummary } from "~/github/types";

describe("parseGitHubUserSummary", () => {
  test("keeps profile metadata used for the subscription confirmation", () => {
    expect(
      parseGitHubUserSummary({
        id: 583231,
        login: "octocat",
        name: "The Octocat",
        bio: "Friendly mascot",
        public_repos: 8,
        followers: 12_345,
        html_url: "https://github.com/octocat"
      })
    ).toEqual({
      id: 583231,
      login: "octocat",
      name: "The Octocat",
      bio: "Friendly mascot",
      publicRepos: 8,
      followers: 12_345,
      htmlUrl: "https://github.com/octocat"
    });
  });
});
