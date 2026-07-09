// Verifies admin-only message helpers and menu labels.
import { describe, expect, test } from "bun:test";

import {
  buildAdminDiagnosticsMessage,
  buildAdminMenuText,
  buildBroadcastConfirmationText,
  formatAdminAccountButton,
  formatAdminChatButton,
  formatAdminSubscriptionButton,
  isAdminUserId
} from "~/bot/commands/admin";

describe("admin helpers", () => {
  test("recognizes configured administrator IDs", () => {
    expect(isAdminUserId(10, [10, 20])).toBe(true);
    expect(isAdminUserId(30, [10, 20])).toBe(false);
  });

  test("builds diagnostics text from counters and DB gauges", () => {
    const message = buildAdminDiagnosticsMessage({
      lastCollectorTickAge: "12s ago",
      githubRateLimitRemaining: "unknown",
      activeSubscriptions: 7,
      activeChats: 3,
      eventsIngestedLast24h: 42,
      errorsLast24h: 2,
      metrics: {
        githubApiRequestsTotal: {
          "200": 4,
          "304": 1,
          "4xx": 0,
          "5xx": 1,
          error: 1
        },
        deliveriesSentTotal: {
          ok: 5,
          empty: 2,
          error: 1
        },
        telegramApiErrorsTotal: {
          "429": 2
        },
        aiSummariesTotal: {
          ok: 3,
          error: 1
        }
      }
    });

    expect(message).toContain("Active subscriptions: 7");
    expect(message).toContain("AI summaries: ok=3, error=1");
  });

  test("formats admin menu list buttons", () => {
    expect(buildAdminMenuText()).toBe("Admin");
    expect(formatAdminChatButton({ id: 1, type: "private", title: null })).toBe(
      "private 1"
    );
    expect(formatAdminAccountButton({ login: "torvalds" })).toBe(
      "@torvalds"
    );
    expect(
      formatAdminSubscriptionButton({
        id: 3,
        accountLogin: "torvalds",
        schedulePreset: "as_fetched"
      })
    ).toBe("#3 @torvalds As fetched");
  });

  test("builds broadcast confirmation text without echoing huge messages", () => {
    expect(buildBroadcastConfirmationText("hello", 2)).toBe(
      "Broadcast to 2 active chats?\n\nhello"
    );
    expect(buildBroadcastConfirmationText("x".repeat(160), 1)).toContain("...");
  });
});
