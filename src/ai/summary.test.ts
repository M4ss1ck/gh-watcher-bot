// Verifies AI summary input building and API response handling without live calls.
import { describe, expect, test } from "bun:test";

import {
  buildAiSummaryInput,
  clampRetryDelay,
  generateAiSummary,
  maxAttempts,
  requestTimeoutMs,
  totalBudgetMs
} from "~/ai/summary";
import { summarizeEvent } from "~/formatting/summarize";
import type { GitHubPullRequestDetail, StoredEvent } from "~/github/types";
import { getMetricsSnapshot, resetMetricsForTests } from "~/lib/metrics";
import {
  pullRequestEvent,
  pushEvent,
  releaseEvent
} from "~/test/fixtures/github-events";

const okResponse = (content: string, finishReason = "stop"): Response =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }]
    }),
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

const mergedPrDetail = (body: string): GitHubPullRequestDetail => ({
  number: 150,
  title: "Add offline cache",
  body,
  htmlUrl: "https://github.com/octocat/hello-world/pull/150",
  merged: true,
  mergedBy: "M4ss1ck",
  additions: 412,
  deletions: 38,
  changedFiles: 9,
  commits: 6
});

describe("buildAiSummaryInput", () => {
  test("groups event lines by repository", () => {
    const input = buildAiSummaryInput([pushEvent, releaseEvent], new Map());

    expect(input).toContain(pushEvent.repoName);
    expect(input).toContain(releaseEvent.repoName);
    expect(input).toContain(pushEvent.actorLogin);
  });

  test("carries more pull request body than the mechanical digest keeps", () => {
    const longBody = "x".repeat(700);
    const details = new Map([[pullRequestEvent.id, mergedPrDetail(longBody)]]);
    const input = buildAiSummaryInput([pullRequestEvent], details);

    // The mechanical renderer truncates the body at 240; the AI input gets 800.
    expect(input).toContain("x".repeat(600));
    expect(input.length).toBeGreaterThan(400);
  });
});

describe("summarizeEvent body budget", () => {
  const longBody = "y".repeat(900);

  test("truncates the pull request body at 240 characters by default", () => {
    const summary = summarizeEvent(pullRequestEvent, {
      pullRequestDetail: mergedPrDetail(longBody)
    });
    const bodyExtra = summary.extra.find((entry) => entry.startsWith("y"));

    expect(bodyExtra).toBeDefined();
    expect(bodyExtra!.length).toBeLessThanOrEqual(240);
  });

  test("honors a larger bodyMaxLength when one is supplied", () => {
    const summary = summarizeEvent(pullRequestEvent, {
      pullRequestDetail: mergedPrDetail(longBody),
      bodyMaxLength: 800
    });
    const bodyExtra = summary.extra.find((entry) => entry.startsWith("y"));

    expect(bodyExtra).toBeDefined();
    expect(bodyExtra!.length).toBeGreaterThan(240);
    expect(bodyExtra!.length).toBeLessThanOrEqual(800);
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

  test("disables thinking and allows enough visible output", async () => {
    let requestBody = "";
    await generateAiSummary(eventsForRepos(3), {
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body);
        return okResponse("Fine.");
      }
    });

    const body = JSON.parse(requestBody);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0.2);
  });

  test("rejects a length-limited response instead of sending its fragment", async () => {
    let attempts = 0;
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      fetchImpl: async () => {
        attempts += 1;
        return okResponse("octocat/hello-w", "length");
      }
    });

    expect(result).toBeNull();
    expect(attempts).toBe(1);
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

    expect(systemPrompt).toContain("Length must match how much there is to say");
    expect(systemPrompt).toContain("drawing on that description");
    expect(systemPrompt).toContain("Never exceed 6 sentences in total");
    expect(systemPrompt).toContain("completing the change");
    expect(systemPrompt).toContain("M4ss1ck merged PR #143");
    expect(systemPrompt).toContain("brevity comes from thin input");
    expect(systemPrompt).toContain("M4ss1ck merged PR #150");
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
