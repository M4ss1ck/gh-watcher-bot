// Builds and parses opencode Go requests for each wire protocol its models are served on.
export type ApiProtocol = "chat" | "responses" | "messages";

export type SummaryModel = {
  id: string;
  protocol: ApiProtocol;
  // Lowest reasoning effort the model accepts, or null when it exposes no effort control.
  reasoningEffort: string | null;
  supportsTemperature: boolean;
};

export type SummaryRequest = {
  system: string;
  input: string;
  maxOutputTokens: number;
  temperature: number;
};

export type RequestIdentity = {
  apiKey: string;
  sessionId: string;
  userAgent: string;
};

export type ApiRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type Completion = {
  text: string;
  // True only when the model finished on its own, not on a token limit or filter.
  complete: boolean;
  stopReason: string | null;
};

const apiBaseUrl = "https://opencode.ai/zen/go/v1";
const anthropicVersion = "2023-06-01";
// Responses models count reasoning against max_output_tokens even at minimal effort;
// muse-spark spent 260-500 reasoning tokens on a three-line digest.
export const reasoningHeadroomTokens = 1_000;

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const lowestReasoningEffort = (values: readonly string[]): string | null => {
  const ranked = values
    .filter((value) => effortOrder.includes(value))
    .sort((left, right) => effortOrder.indexOf(left) - effortOrder.indexOf(right));

  return ranked[0] ?? null;
};

export const buildApiRequest = (
  model: SummaryModel,
  request: SummaryRequest,
  identity: RequestIdentity
): ApiRequest => {
  const commonHeaders = {
    "content-type": "application/json",
    "user-agent": identity.userAgent,
    "x-opencode-session": identity.sessionId
  };
  const temperature = model.supportsTemperature ? { temperature: request.temperature } : {};

  if (model.protocol === "responses") {
    return {
      url: `${apiBaseUrl}/responses`,
      headers: { ...commonHeaders, authorization: `Bearer ${identity.apiKey}` },
      body: JSON.stringify({
        model: model.id,
        instructions: request.system,
        input: request.input,
        ...(model.reasoningEffort === null
          ? {}
          : { reasoning: { effort: model.reasoningEffort } }),
        ...temperature,
        max_output_tokens: request.maxOutputTokens + reasoningHeadroomTokens
      })
    };
  }

  if (model.protocol === "messages") {
    return {
      url: `${apiBaseUrl}/messages`,
      headers: {
        ...commonHeaders,
        "x-api-key": identity.apiKey,
        "anthropic-version": anthropicVersion
      },
      body: JSON.stringify({
        model: model.id,
        system: request.system,
        messages: [{ role: "user", content: request.input }],
        thinking: { type: "disabled" },
        ...temperature,
        max_tokens: request.maxOutputTokens
      })
    };
  }

  return {
    url: `${apiBaseUrl}/chat/completions`,
    headers: { ...commonHeaders, authorization: `Bearer ${identity.apiKey}` },
    body: JSON.stringify({
      model: model.id,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.input }
      ],
      // Hidden reasoning consumes the completion budget before the digest text.
      thinking: { type: "disabled" },
      ...temperature,
      max_tokens: request.maxOutputTokens
    })
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const joinTextBlocks = (blocks: unknown[], textType: string): string =>
  blocks
    .filter(isRecord)
    .filter((block) => block.type === textType && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");

const parseChat = (data: Record<string, unknown>): Completion | null => {
  const choices = data.choices;

  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    return null;
  }

  const first = choices[0];
  const message = isRecord(first.message) ? first.message : null;
  const content = message?.content;

  // Reasoning models return null content when the token limit hits mid-thought.
  if (message === null || (typeof content !== "string" && content !== null)) {
    return null;
  }

  const stopReason = typeof first.finish_reason === "string" ? first.finish_reason : null;

  return { text: content ?? "", complete: stopReason === "stop", stopReason };
};

const parseResponses = (data: Record<string, unknown>): Completion | null => {
  if (typeof data.status !== "string" || !Array.isArray(data.output)) {
    return null;
  }

  const text = data.output
    .filter(isRecord)
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .map((item) => joinTextBlocks(item.content as unknown[], "output_text"))
    .join("");
  const incompleteReason =
    isRecord(data.incomplete_details) && typeof data.incomplete_details.reason === "string"
      ? data.incomplete_details.reason
      : null;

  return {
    text,
    complete: data.status === "completed",
    stopReason: incompleteReason ?? data.status
  };
};

const parseMessages = (data: Record<string, unknown>): Completion | null => {
  if (!Array.isArray(data.content)) {
    return null;
  }

  const stopReason = typeof data.stop_reason === "string" ? data.stop_reason : null;

  return {
    text: joinTextBlocks(data.content, "text"),
    complete: stopReason === "end_turn",
    stopReason
  };
};

export const parseCompletion = (protocol: ApiProtocol, data: unknown): Completion | null => {
  if (!isRecord(data)) {
    return null;
  }

  if (protocol === "responses") {
    return parseResponses(data);
  }

  if (protocol === "messages") {
    return parseMessages(data);
  }

  return parseChat(data);
};
