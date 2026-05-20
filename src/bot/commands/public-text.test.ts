// Verifies public bot command message text.
import { describe, expect, test } from "bun:test";

import { helpMessage } from "~/bot/commands/help";
import { buildPingMessage } from "~/bot/commands/ping";
import { groupStartMessage, privateStartMessage } from "~/bot/commands/start";

describe("public bot command text", () => {
  test("start messages introduce the bot", () => {
    expect(privateStartMessage).toContain("GitHub activity");
    expect(groupStartMessage).toContain("public GitHub activity");
  });

  test("help lists only the public shell commands", () => {
    expect(helpMessage).toContain("/start");
    expect(helpMessage).toContain("/help");
    expect(helpMessage).toContain("/ping");
    expect(helpMessage).not.toContain("/admin");
    expect(helpMessage).not.toContain("/subscribe");
  });

  test("ping reports collector age in seconds", () => {
    expect(buildPingMessage(1_000, 4_500)).toBe(
      "alive, last collector tick 3s ago"
    );
  });

  test("ping reports unavailable when no heartbeat exists", () => {
    expect(buildPingMessage(null, 4_500)).toBe(
      "alive, last collector tick unavailable"
    );
  });

  test("admin ping includes diagnostics", () => {
    expect(
      buildPingMessage(null, 4_500, {
        activeSubscriptions: 1,
        activeChats: 2,
        eventsIngestedLast24h: 3,
        errorsLast24h: 0,
        githubRateLimitRemaining: "unknown"
      })
    ).toContain("active subs 1");
  });
});
