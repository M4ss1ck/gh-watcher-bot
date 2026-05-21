// Verifies subscribe command input helpers.
import { describe, expect, test } from "bun:test";

import {
  TextInputTtlMap,
  formatSubscriptionCreateError,
  parseSubscribeTarget,
  normalizeGitHubLogin,
  subscribeUsageText
} from "~/bot/commands/subscribe";

describe("normalizeGitHubLogin", () => {
  test("accepts username text with an optional @ prefix", () => {
    expect(normalizeGitHubLogin("@torvalds")).toBe("torvalds");
    expect(normalizeGitHubLogin(" M4ss1ck ")).toBe("M4ss1ck");
  });

  test("rejects invalid username text", () => {
    expect(normalizeGitHubLogin("bad/name")).toBeNull();
    expect(normalizeGitHubLogin("-bad")).toBeNull();
    expect(normalizeGitHubLogin("bad-")).toBeNull();
  });
});

describe("parseSubscribeTarget", () => {
  test("accepts owner targets with or without @", () => {
    expect(parseSubscribeTarget("@torvalds")).toEqual({
      type: "account",
      login: "torvalds"
    });
    expect(parseSubscribeTarget("torvalds")).toEqual({
      type: "account",
      login: "torvalds"
    });
  });

  test("accepts repo targets with or without @ on the owner", () => {
    expect(parseSubscribeTarget("@torvalds/linux")).toEqual({
      type: "repo",
      owner: "torvalds",
      repo: "linux"
    });
    expect(parseSubscribeTarget("torvalds/git")).toEqual({
      type: "repo",
      owner: "torvalds",
      repo: "git"
    });
  });

  test("accepts GitHub profile and repo URLs", () => {
    expect(parseSubscribeTarget("https://github.com/torvalds")).toEqual({
      type: "account",
      login: "torvalds"
    });
    expect(parseSubscribeTarget("https://github.com/torvalds/linux")).toEqual({
      type: "repo",
      owner: "torvalds",
      repo: "linux"
    });
    expect(parseSubscribeTarget("github.com/torvalds/linux/")).toEqual({
      type: "repo",
      owner: "torvalds",
      repo: "linux"
    });
    expect(parseSubscribeTarget("https://github.com/torvalds/linux/issues/1")).toEqual({
      type: "repo",
      owner: "torvalds",
      repo: "linux"
    });
  });

  test("rejects non-GitHub URLs", () => {
    expect(parseSubscribeTarget("https://example.com/torvalds/linux")).toBeNull();
  });

  test("rejects invalid targets", () => {
    expect(parseSubscribeTarget("bad/name/extra")).toBeNull();
    expect(parseSubscribeTarget("-bad/repo")).toBeNull();
  });
});

describe("subscribeUsageText", () => {
  test("does not contain HTML-looking placeholders", () => {
    expect(subscribeUsageText).not.toContain("<");
    expect(subscribeUsageText).not.toContain(">");
  });
});

describe("formatSubscriptionCreateError", () => {
  test("formats login values with or without an @ prefix", () => {
    expect(formatSubscriptionCreateError("ghost", { status: 404 })).toBe(
      "GitHub user @ghost was not found."
    );
    expect(formatSubscriptionCreateError("@ghost", { status: 404 })).toBe(
      "GitHub user @ghost was not found."
    );
  });
});

describe("TextInputTtlMap", () => {
  test("expires entries after ttl", () => {
    const inputs = new TextInputTtlMap(60_000);

    inputs.set(
      { chatId: 1, userId: 2 },
      { waitingFor: "username" },
      1_000
    );

    expect(inputs.take({ chatId: 1, userId: 2 }, 30_000)).toEqual({
      waitingFor: "username"
    });

    inputs.set(
      { chatId: 1, userId: 2 },
      { waitingFor: "timezone" },
      1_000
    );

    expect(inputs.take({ chatId: 1, userId: 2 }, 62_000)).toBeNull();
  });
});
