// Verifies AI summary input building and API response handling without live calls.
import { describe, expect, test } from "bun:test";

import { buildAiSummaryInput, generateAiSummary } from "~/ai/summary";
import { pushEvent, releaseEvent } from "~/test/fixtures/github-events";

const okResponse = (content: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

describe("buildAiSummaryInput", () => {
  test("groups event lines by repository", () => {
    const input = buildAiSummaryInput([pushEvent, releaseEvent], new Map());

    expect(input).toContain(pushEvent.repoName);
    expect(input).toContain(releaseEvent.repoName);
    expect(input).toContain(pushEvent.actorLogin);
  });
});

describe("generateAiSummary", () => {
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

  test("returns null on a non-200 response", async () => {
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      fetchImpl: async () => new Response("nope", { status: 500 })
    });

    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      fetchImpl: async () => {
        throw new Error("network down");
      }
    });

    expect(result).toBeNull();
  });

  test("returns null on an empty completion", async () => {
    const result = await generateAiSummary([pushEvent], {
      apiKey: "test-key",
      fetchImpl: async () => okResponse("   ")
    });

    expect(result).toBeNull();
  });
});
