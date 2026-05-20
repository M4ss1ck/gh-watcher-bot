// Verifies in-memory counters used by admin diagnostics.
import { describe, expect, test } from "bun:test";

import {
  getMetricsSnapshot,
  incrementDeliverySent,
  incrementEventsCollected,
  incrementGitHubApiRequest,
  incrementTelegramApiError,
  observeDeliveryDuration,
  resetMetricsForTests
} from "~/lib/metrics";

describe("metrics", () => {
  test("tracks typed counters and delivery duration samples", () => {
    resetMetricsForTests();

    incrementGitHubApiRequest("200");
    incrementGitHubApiRequest("304");
    incrementEventsCollected("PushEvent");
    incrementDeliverySent("ok");
    incrementTelegramApiError(429);
    observeDeliveryDuration(125);

    expect(getMetricsSnapshot()).toEqual({
      githubApiRequestsTotal: {
        "200": 1,
        "304": 1,
        "4xx": 0,
        "5xx": 0,
        error: 0
      },
      eventsCollectedTotal: {
        PushEvent: 1
      },
      deliveriesSentTotal: {
        ok: 1,
        empty: 0,
        error: 0
      },
      deliveryDurationMs: [125],
      telegramApiErrorsTotal: {
        "429": 1
      }
    });
  });
});
