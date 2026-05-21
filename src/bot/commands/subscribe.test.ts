// Verifies subscribe command input helpers.
import { describe, expect, test } from "bun:test";

import {
  TextInputTtlMap,
  formatSubscriptionCreateError,
  normalizeGitHubLogin
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
