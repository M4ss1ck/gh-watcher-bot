// Verifies subscription filter application with handwritten event fixtures.
import { describe, expect, test } from "bun:test";

import { applyFilters } from "~/filters/apply";
import { filterPresets } from "~/filters/presets";
import {
  createEvent,
  fixtureEvents,
  forkEvent,
  pullRequestEvent,
  pushEvent,
  releaseEvent,
  starEvent
} from "~/test/fixtures/github-events";

describe("filter presets", () => {
  test("defines the required preset event sets", () => {
    expect(filterPresets.firehose.events).toContain("push");
    expect(filterPresets.releases_only.events).toEqual(["release"]);
    expect(filterPresets.prs_and_releases.events).toEqual([
      "pull_request",
      "release",
      "repository"
    ]);
    expect(filterPresets.code_activity.branches.include).toEqual([
      "main",
      "master"
    ]);
    expect(filterPresets.new_stuff.events).toEqual([
      "repository",
      "release",
      "fork",
      "star",
      "create"
    ]);
  });
});

describe("applyFilters", () => {
  test("matches event categories from GitHub event type names", () => {
    expect(applyFilters(filterPresets.code_activity, pushEvent)).toBe(true);
    expect(applyFilters(filterPresets.code_activity, pullRequestEvent)).toBe(true);
    expect(applyFilters(filterPresets.code_activity, releaseEvent)).toBe(false);
    expect(applyFilters(filterPresets.new_stuff, starEvent)).toBe(true);
    expect(applyFilters(filterPresets.new_stuff, createEvent)).toBe(true);
  });

  test("honors repo include and exclude globs", () => {
    expect(
      applyFilters(
        {
          ...filterPresets.firehose,
          repos: {
            include: ["octocat/*"],
            exclude: ["*/archived"]
          }
        },
        pushEvent
      )
    ).toBe(true);
    expect(
      applyFilters(
        {
          ...filterPresets.firehose,
          repos: {
            include: ["torvalds/*"],
            exclude: []
          }
        },
        pushEvent
      )
    ).toBe(false);
  });

  test("honors branch and minimum push commit filters", () => {
    expect(
      applyFilters(
        {
          ...filterPresets.code_activity,
          minCommitsPerPush: 3
        },
        pushEvent
      )
    ).toBe(false);
    expect(
      applyFilters(
        {
          ...filterPresets.code_activity,
          branches: {
            include: ["develop"],
            exclude: []
          }
        },
        pushEvent
      )
    ).toBe(false);
  });

  test("ignores bot authors when configured", () => {
    expect(applyFilters(filterPresets.releases_only, releaseEvent)).toBe(false);
    expect(
      applyFilters(
        {
          ...filterPresets.releases_only,
          ignoreBotAuthors: false
        },
        releaseEvent
      )
    ).toBe(true);
  });

  test("filters a mixed event list", () => {
    expect(fixtureEvents.filter((event) => applyFilters(filterPresets.new_stuff, event))).toEqual([
      starEvent,
      forkEvent,
      createEvent
    ]);
  });
});
