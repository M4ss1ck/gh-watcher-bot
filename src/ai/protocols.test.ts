// Verifies request shapes and response parsing for each opencode Go wire protocol.
import { describe, expect, test } from "bun:test";

import {
  buildApiRequest,
  lowestReasoningEffort,
  parseCompletion,
  reasoningHeadroomTokens,
  type SummaryModel
} from "~/ai/protocols";

const identity = { apiKey: "k", sessionId: "s", userAgent: "ua" };
const request = { system: "sys", input: "in", maxOutputTokens: 1000, temperature: 0.2 };

const model = (overrides: Partial<SummaryModel>): SummaryModel => ({
  id: "m",
  protocol: "chat",
  reasoningEffort: null,
  supportsTemperature: true,
  ...overrides
});

describe("lowestReasoningEffort", () => {
  test("picks the cheapest effort the model lists", () => {
    expect(lowestReasoningEffort(["minimal", "low", "medium", "high", "xhigh"])).toBe("minimal");
    expect(lowestReasoningEffort(["high", "low", "max"])).toBe("low");
  });

  test("returns null when no known effort is listed", () => {
    expect(lowestReasoningEffort([])).toBeNull();
    expect(lowestReasoningEffort(["turbo"])).toBeNull();
  });
});

describe("buildApiRequest", () => {
  test("chat models go to chat/completions with thinking disabled", () => {
    const built = buildApiRequest(model({}), request, identity);
    const body = JSON.parse(built.body);

    expect(built.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(built.headers.authorization).toBe("Bearer k");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "in" }
    ]);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0.2);
  });

  test("responses models get minimal reasoning and room for it in the token budget", () => {
    const built = buildApiRequest(
      model({ protocol: "responses", reasoningEffort: "minimal" }),
      request,
      identity
    );
    const body = JSON.parse(built.body);

    expect(built.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(built.headers.authorization).toBe("Bearer k");
    expect(body.instructions).toBe("sys");
    expect(body.input).toBe("in");
    expect(body.reasoning).toEqual({ effort: "minimal" });
    expect(body.max_output_tokens).toBe(1000 + reasoningHeadroomTokens);
    expect(body.thinking).toBeUndefined();
  });

  test("responses models without effort control send no reasoning field", () => {
    const body = JSON.parse(
      buildApiRequest(model({ protocol: "responses" }), request, identity).body
    );

    expect(body.reasoning).toBeUndefined();
  });

  test("messages models use the Anthropic auth headers", () => {
    const built = buildApiRequest(model({ protocol: "messages" }), request, identity);
    const body = JSON.parse(built.body);

    expect(built.url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(built.headers["x-api-key"]).toBe("k");
    expect(built.headers["anthropic-version"]).toBe("2023-06-01");
    expect(built.headers.authorization).toBeUndefined();
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "in" }]);
    expect(body.max_tokens).toBe(1000);
  });

  test("omits temperature for models that reject it", () => {
    const body = JSON.parse(
      buildApiRequest(model({ supportsTemperature: false }), request, identity).body
    );

    expect(body.temperature).toBeUndefined();
  });

  test("always sends the session and user agent headers", () => {
    for (const protocol of ["chat", "responses", "messages"] as const) {
      const built = buildApiRequest(model({ protocol }), request, identity);

      expect(built.headers["x-opencode-session"]).toBe("s");
      expect(built.headers["user-agent"]).toBe("ua");
    }
  });
});

describe("parseCompletion", () => {
  test("chat: stop is complete, length is not", () => {
    expect(
      parseCompletion("chat", {
        choices: [{ finish_reason: "stop", message: { content: "Hi" } }]
      })
    ).toEqual({ text: "Hi", complete: true, stopReason: "stop" });
    expect(
      parseCompletion("chat", {
        choices: [{ finish_reason: "length", message: { content: "Hi" } }]
      })?.complete
    ).toBe(false);
  });

  test("chat: null content from a model that ran out mid-reasoning is incomplete, not unparseable", () => {
    expect(
      parseCompletion("chat", {
        choices: [{ finish_reason: "length", message: { content: null, reasoning: "..." } }]
      })
    ).toEqual({ text: "", complete: false, stopReason: "length" });
  });

  test("responses: joins output_text from message items and skips reasoning items", () => {
    expect(
      parseCompletion("responses", {
        status: "completed",
        incomplete_details: null,
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            content: [
              { type: "output_text", text: "one " },
              { type: "output_text", text: "two" }
            ]
          }
        ]
      })
    ).toEqual({ text: "one two", complete: true, stopReason: "completed" });
  });

  test("responses: incomplete status reports its reason", () => {
    expect(
      parseCompletion("responses", {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: []
      })
    ).toEqual({ text: "", complete: false, stopReason: "max_output_tokens" });
  });

  test("messages: end_turn is complete, max_tokens is not", () => {
    expect(
      parseCompletion("messages", {
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "x" },
          { type: "text", text: "Done." }
        ]
      })
    ).toEqual({ text: "Done.", complete: true, stopReason: "end_turn" });
    expect(
      parseCompletion("messages", { stop_reason: "max_tokens", content: [] })?.complete
    ).toBe(false);
  });

  test("returns null for a shape that belongs to another protocol", () => {
    expect(parseCompletion("responses", { choices: [] })).toBeNull();
    expect(parseCompletion("messages", { output: [] })).toBeNull();
    expect(parseCompletion("chat", { content: [] })).toBeNull();
    expect(parseCompletion("chat", null)).toBeNull();
  });
});
