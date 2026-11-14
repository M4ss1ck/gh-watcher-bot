// Verifies in-memory counters used by admin diagnostics.
import { describe, expect, test } from "bun:test";

import {
  getMetricsSnapshot,
  incrementAiSummary,
  incrementDigestFormat,
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
      },
      aiSummariesTotal: {
        ok: 0,
        error: 0
      },
      digestFormatTotal: {
        rich: 0,
        html_fallback: 0
      }
    });
  });

  test("counts ai summary outcomes", () => {
    resetMetricsForTests();
    incrementAiSummary("ok");
    incrementAiSummary("error");
    incrementAiSummary("error");

    const snapshot = getMetricsSnapshot();

    expect(snapshot.aiSummariesTotal).toEqual({ ok: 1, error: 2 });
  });

  test("counts digest formats and resets them", () => {
    resetMetricsForTests();
    incrementDigestFormat("rich");
    incrementDigestFormat("rich");
    incrementDigestFormat("html_fallback");

    expect(getMetricsSnapshot().digestFormatTotal).toEqual({ rich: 2, html_fallback: 1 });

    resetMetricsForTests();
    expect(getMetricsSnapshot().digestFormatTotal).toEqual({ rich: 0, html_fallback: 0 });
  });
});
