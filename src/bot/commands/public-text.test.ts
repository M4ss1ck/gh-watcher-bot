// Verifies public bot command message text.
import { describe, expect, test } from "bun:test";

import { buildHelpMessage } from "~/bot/commands/help";
import { buildPingMessage } from "~/bot/commands/ping";
import { groupStartMessage, privateStartMessage } from "~/bot/commands/start";

describe("public bot command text", () => {
  test("start messages introduce the bot", () => {
    expect(privateStartMessage).toContain("GitHub activity");
    expect(groupStartMessage).toContain("public GitHub activity");
  });

  test("help for non-admin users lists public commands without /admin", () => {
    const message = buildHelpMessage(false);
    expect(message).toContain("/start");
    expect(message).toContain("/help");
    expect(message).toContain("/ping");
    expect(message).toContain("/subscribe");
    expect(message).not.toContain("/admin");
  });

  test("help for admin users adds /admin", () => {
    const message = buildHelpMessage(true);
    expect(message).toContain("/subscribe");
    expect(message).toContain("/admin");
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
