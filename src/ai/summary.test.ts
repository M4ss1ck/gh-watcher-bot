// Verifies AI summary input building and API response handling without live calls.
import { describe, expect, test } from "bun:test";

import {
  buildAiSummaryInput,
  clampRetryDelay,
  generateAiSummary,
  maxAttempts,
  requestTimeoutMs,
  summaryTokenBudget,
  totalBudgetMs
} from "~/ai/summary";
import { getMetricsSnapshot, resetMetricsForTests } from "~/lib/metrics";
import type { StoredEvent } from "~/github/types";
import { pushEvent, releaseEvent } from "~/test/fixtures/github-events";

const okResponse = (content: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const eventsForRepos = (count: number): StoredEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `repo-event-${index}`,
    accountId: 1,
    type: "PushEvent",
    repoName: `owner/repo-${index}`,
    actorLogin: "octocat",
    payload: {},
    createdAt: new Date("2026-01-01T00:00:00Z")
  }));

describe("buildAiSummaryInput", () => {
  test("groups event lines by repository", () => {
    const input = buildAiSummaryInput([pushEvent, releaseEvent], new Map());

    expect(input).toContain(pushEvent.repoName);
    expect(input).toContain(releaseEvent.repoName);
    expect(input).toContain(pushEvent.actorLogin);
  });
});

describe("generateAiSummary", () => {
  const noopDelay = async (): Promise<void> => {};

  test("returns the model text on success", async () => {
    let requestBody = "";
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body);
        return okResponse("A quiet day with one push.");
      }
    });

    expect(result).toBe("A quiet day with one push.");
    expect(requestBody).toContain("deepseek-v4-flash");
  });

  test("sends the scaled token budget and temperature", async () => {
    let requestBody = "";
    await generateAiSummary(eventsForRepos(3), {
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body);
        return okResponse("Fine.");
      }
    });

    const body = JSON.parse(requestBody);
    expect(body.max_tokens).toBe(180);
    expect(body.temperature).toBe(0.2);
  });

  test("system prompt states the conciseness rules and examples", async () => {
    let requestBody = "";
    await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body);
        return okResponse("Fine.");
      }
    });

    const body = JSON.parse(requestBody);
    const systemPrompt = body.messages[0].content;

    expect(systemPrompt).toContain("Write ONE sentence per repository");
    expect(systemPrompt).toContain("Never more than 4 sentences in total");
    expect(systemPrompt).toContain("completing the change");
    expect(systemPrompt).toContain("M4ss1ck merged PR #143");
  });

  test("returns null on a non-200 response", async () => {
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => new Response("nope", { status: 500 })
    });

    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => {
        throw new Error("network down");
      }
    });

    expect(result).toBeNull();
  });

  test("returns null on an empty completion", async () => {
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => okResponse("   ")
    });

    expect(result).toBeNull();
  });

  test("retries a 429 and succeeds on the second attempt", async () => {
    let attempts = 0;
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("rate limited", { status: 429 });
        }
        return okResponse("Recovered from rate limiting.");
      }
    });

    expect(result).toBe("Recovered from rate limiting.");
    expect(attempts).toBe(2);
  });

  test("honors a Retry-After header on a 429", async () => {
    let attempts = 0;
    const waitedMs: number[] = [];
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: async (ms) => {
        waitedMs.push(ms);
      },
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "5" }
          });
        }
        return okResponse("Done.");
      }
    });

    expect(result).toBe("Done.");
    expect(waitedMs[0]).toBe(5000);
  });

  test("retries two 500s and succeeds on the third attempt", async () => {
    let attempts = 0;
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response("boom", { status: 500 });
        }
        return okResponse("Succeeded on the third try.");
      }
    });

    expect(result).toBe("Succeeded on the third try.");
    expect(attempts).toBe(3);
  });

  test("does not retry a permanent 400", async () => {
    let attempts = 0;
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => {
        attempts += 1;
        return new Response("bad request", { status: 400 });
      }
    });

    expect(result).toBeNull();
    expect(attempts).toBe(1);
  });

  test("returns null after three consecutive 500s", async () => {
    let attempts = 0;
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => {
        attempts += 1;
        return new Response("boom", { status: 500 });
      }
    });

    expect(result).toBeNull();
    expect(attempts).toBe(3);
  });

  test("retries an empty completion and returns the follow-up text", async () => {
    let attempts = 0;
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return okResponse("   ");
        }
        return okResponse("A proper summary.");
      }
    });

    expect(result).toBe("A proper summary.");
    expect(attempts).toBe(2);
  });

  test("increments the error metric exactly once when retries are exhausted", async () => {
    resetMetricsForTests();
    await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      delay: noopDelay,
      fetchImpl: async () => new Response("boom", { status: 500 })
    });

    expect(getMetricsSnapshot().aiSummariesTotal.error).toBe(1);
  });
});

describe("summaryTokenBudget", () => {
  test("scales with the number of distinct repositories", () => {
    expect(summaryTokenBudget([pushEvent])).toBe(100);
    expect(summaryTokenBudget([pushEvent, releaseEvent])).toBe(100);
    expect(summaryTokenBudget(eventsForRepos(3))).toBe(180);
  });

  test("stays within the floor and the cap", () => {
    expect(summaryTokenBudget([])).toBe(100);
    expect(summaryTokenBudget(eventsForRepos(20))).toBe(400);
  });
});

describe("retry budget", () => {
  test("worst case fits the total budget by construction", () => {
    const maxTotalRetryDelayMs = totalBudgetMs - maxAttempts * requestTimeoutMs;

    expect(maxAttempts * requestTimeoutMs + maxTotalRetryDelayMs).toBeLessThanOrEqual(totalBudgetMs);
    expect(maxTotalRetryDelayMs).toBeGreaterThanOrEqual(0);
  });

  test("clamps a retry delay that would exceed the remaining budget", () => {
    expect(clampRetryDelay(5_000, totalBudgetMs)).toBe(5_000);
    expect(clampRetryDelay(5_000, 13_000)).toBe(1_000);
    expect(clampRetryDelay(1_000, 11_000)).toBeNull();
  });
});
