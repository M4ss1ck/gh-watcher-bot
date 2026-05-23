// Verifies subscription filter shape migrations are correct and idempotent.
import { describe, expect, test } from "bun:test";

import { migrateFilters } from "~/db/data-migrate";

describe("migrateFilters", () => {
  test("expands legacy pull_request, issues, and create event values", () => {
    const result = migrateFilters({
      events: ["push", "pull_request", "issues", "create", "release"],
      repos: { include: ["*"], exclude: [] },
      ignoreBotAuthors: true,
      minCommitsPerPush: 1,
      branches: { include: ["*"], exclude: [] }
    });

    expect(result?.changed).toBe(true);
    expect(result?.filters.events).toEqual([
      "push",
      "pull_request_opened",
      "pull_request_closed",
      "pull_request_merged",
      "pull_request_reopened",
      "issue_opened",
      "issue_closed",
      "issue_reopened",
      "branch_created",
      "tag_created",
      "release"
    ]);
    expect(result?.filters.enrichMergedPullRequests).toBe(false);
  });

  test("adds enrichMergedPullRequests to filters that already use new values", () => {
    const result = migrateFilters({
      events: ["pull_request_merged"],
      repos: { include: ["*"], exclude: [] },
      ignoreBotAuthors: true,
      minCommitsPerPush: 1,
      branches: { include: ["*"], exclude: [] }
    });

    expect(result?.changed).toBe(true);
    expect(result?.filters.enrichMergedPullRequests).toBe(false);
  });

  test("is idempotent for filters that already have the new shape", () => {
    const filters = {
      events: ["pull_request_merged"],
      repos: { include: ["*"], exclude: [] },
      ignoreBotAuthors: true,
      minCommitsPerPush: 1,
      branches: { include: ["*"], exclude: [] },
      enrichMergedPullRequests: true
    };

    expect(migrateFilters(filters)?.changed).toBe(false);
  });
});
