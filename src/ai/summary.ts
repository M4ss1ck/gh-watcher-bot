// Generates prose digest summaries through the cheapest working opencode Go model.
import {
  createModelSelector,
  loadRankedModels,
  type ModelSelector
} from "~/ai/models";
import { buildApiRequest, parseCompletion, type SummaryModel } from "~/ai/protocols";
import type { GitHubPullRequestDetail, StoredEvent } from "~/github/types";
import { summarizeEvent } from "~/formatting/summarize";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { incrementAiSummary } from "~/lib/metrics";

// opencode Go asks clients to identify themselves and send one stable session ID per conversation.
const userAgent = "gh-watcher-bot/1.0";
export const requestTimeoutMs = 12_000;
const maxInputChars = 24_000;
const maxSummaryChars = 3_000;
const aiBodyMaxChars = 800;
const maxCompletionTokens = 1_000;
export const maxAttempts = 3;
const retryBackoffMs = [1_000, 2_000];
const maxJitterMs = 250;
const maxRetryAfterMs = 5_000;
export const totalBudgetMs = 40_000;

const systemPrompt = `You summarize GitHub activity for a Telegram digest bot.

Rules:
- Plain text only. No markdown, no HTML, no headings, no bullet points.
- Length must match how much there is to say. Do not pad, and do not omit real content either.
- When the input holds nothing beyond the event itself, one short sentence for that repository is correct.
- When a pull request description is present, say what the change actually does, drawing on that description. Up to three sentences for that repository is fine when there is that much real content.
- Never exceed 6 sentences in total.
- The repository name is shown above your summary. Do not repeat it in the output.
- Use active voice and always name the person who did it. Never write "a branch was created" without saying who created it.
- State only what happened. Never explain why it matters, what it indicates, what it means, or what is most notable.
- Never write a closing, completion, or summarising sentence.
- Collapse a chain of related events into its end state. A branch created, then a pull request opened from it, then that pull request merged, is ONE fact: the merge. Do not narrate the sequence that led there.
- Do not restate the same fact at different levels of detail.
- Banned phrasings, including anything similar: "saw activity", "the most notable", "this indicates", "which means", "overall", "in summary", "notably", "completing the change", "subsequently", "followed by".
- Do not invent anything absent from the input.

Examples:
Neither pull request in the two pairs below had a description available, so one short line was all there was to say. Their brevity comes from thin input, not from a length target.

bad: M4ss1ck/maibuk saw activity around a new branch and pull request. M4ss1ck created the branch M4ss1ck/projects-archive-books, then opened and later merged pull request #143, which brings that branch into the main branch. The merge is the most notable change, indicating the projects-archive-books work is now part of the main codebase.
good: M4ss1ck merged PR #143 (projects-archive-books) into main.

bad: In M4ss1ck/maibuk, a new branch M4ss1ck/better-canvas was created, followed by pull request #142 from that branch into main. The pull request was subsequently opened and then merged, completing the change.
good: M4ss1ck merged PR #142 (better-canvas) into main.

good (rich input):
input: - M4ss1ck merged pull request #150: Add offline cache (feature/offline-cache -> main) (+412 -38 across 9 files; 6 commits; Adds a service-worker layer that caches book pages and syncs reading progress when the connection returns. Falls back to the network when the cache is stale.)
output: M4ss1ck merged PR #150 (offline-cache), adding a service-worker layer that caches book pages and syncs reading progress when the connection returns, falling back to the network when the cache is stale.
This output is longer because the input had more real content, not because longer is better.`;

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type DelayFn = (ms: number) => Promise<void>;

export type GenerateAiSummaryOptions = {
  pullRequestDetails?: Map<string, GitHubPullRequestDetail>;
  fetchImpl?: FetchImpl;
  apiKey?: string;
  delay?: DelayFn;
  modelSelector?: Pick<ModelSelector, "getModel" | "reportFailure">;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const jittered = (baseMs: number): number => baseMs + Math.random() * maxJitterMs;

const plannedRetryDelayMs = (attempt: number, response: Response | null): number => {
  if (response !== null) {
    const retryAfterMs = parseRetryAfterMs(response);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }
  }

  return jittered(retryBackoffMs[attempt - 1] ?? 0);
};

export const clampRetryDelay = (plannedMs: number, remainingBudgetMs: number): number | null => {
  const maxDelayMs = remainingBudgetMs - requestTimeoutMs;

  if (maxDelayMs < 0) {
    return null;
  }

  return Math.min(plannedMs, maxDelayMs);
};

const retryDelayFor = (attempt: number, response: Response | null, startedAt: number): number | null => {
  if (attempt >= maxAttempts) {
    return null;
  }

  const remainingBudgetMs = totalBudgetMs - (Date.now() - startedAt);

  return clampRetryDelay(plannedRetryDelayMs(attempt, response), remainingBudgetMs);
};

const parseRetryAfterMs = (response: Response): number | null => {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return null;
  }

  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const ms = Math.round(seconds * 1000);

  return ms <= maxRetryAfterMs ? ms : null;
};

export const isAiSummaryAvailable = (): boolean =>
  typeof env.OPENCODE_API_KEY === "string" && env.OPENCODE_API_KEY.length > 0;

export const buildAiSummaryInput = (
  events: StoredEvent[],
  pullRequestDetails: Map<string, GitHubPullRequestDetail>
): string => {
  const byRepo = new Map<string, string[]>();

  for (const event of events) {
    const summary = summarizeEvent(event, {
      pullRequestDetail: pullRequestDetails.get(event.id) ?? null,
      bodyMaxLength: aiBodyMaxChars
    });
    const lines = byRepo.get(event.repoName) ?? [];
    const detail = summary.detail === null ? "" : `: ${summary.detail}`;
    const extras = summary.extra.length === 0 ? "" : ` (${summary.extra.join("; ")})`;
    lines.push(`- ${event.actorLogin} ${summary.title}${detail}${extras}`);
    byRepo.set(event.repoName, lines);
  }

  const sections = [...byRepo.entries()].map(
    ([repoName, lines]) => `${repoName}:\n${lines.join("\n")}`
  );

  return sections.join("\n\n").slice(0, maxInputChars);
};

// A small digest with a pull request description, so a probe exercises the same prompt,
// parameters, and reasoning cost as a real delivery.
const probeInput = `octocat/hello-world:
- octocat merged pull request #7: Add retry budget (retry-budget -> main) (+120 -14 across 3 files; 2 commits; Caps total retry time for outbound API calls at 40 seconds and clamps each backoff so the last attempt still fits.)
- octocat published release v1.4.0: v1.4.0`;

const summaryRequest = (input: string) => ({
  system: systemPrompt,
  input,
  maxOutputTokens: maxCompletionTokens,
  temperature: 0.2
});

const sendSummaryRequest = (
  fetchImpl: FetchImpl,
  model: SummaryModel,
  input: string,
  apiKey: string,
  sessionId: string
): Promise<Response> => {
  const request = buildApiRequest(model, summaryRequest(input), { apiKey, sessionId, userAgent });

  return fetchImpl(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
};

export const probeSummaryModel = async (
  model: SummaryModel,
  options: { fetchImpl: FetchImpl; apiKey: string }
): Promise<boolean> => {
  try {
    const response = await sendSummaryRequest(
      options.fetchImpl,
      model,
      probeInput,
      options.apiKey,
      crypto.randomUUID()
    );
    const completion = response.ok
      ? parseCompletion(model.protocol, await response.json())
      : null;
    const passed = completion !== null && completion.complete && completion.text.trim().length > 0;

    logger.debug(
      { model: model.id, status: response.status, stop_reason: completion?.stopReason, passed },
      "ai summary model probed"
    );

    return passed;
  } catch (error) {
    logger.debug({ model: model.id, err: error }, "ai summary model probe errored");

    return false;
  }
};

let defaultModelSelector: ModelSelector | null = null;

export const getSummaryModelSelector = (): ModelSelector => {
  defaultModelSelector ??= createModelSelector({
    loadModels: () => loadRankedModels({ fetchImpl: fetch, apiKey: env.OPENCODE_API_KEY ?? "" }),
    probe: (model) => probeSummaryModel(model, { fetchImpl: fetch, apiKey: env.OPENCODE_API_KEY ?? "" })
  });

  return defaultModelSelector;
};

// 401/402/403 point at the API key or billing and 429 at load, not at the model.
const accountLevelStatuses = new Set([401, 402, 403, 429]);

const isModelRejection = (status: number): boolean =>
  status >= 400 && status < 500 && !accountLevelStatuses.has(status);

export const generateAiSummary = async (
  events: StoredEvent[],
  options: GenerateAiSummaryOptions = {}
): Promise<string | null> => {
  const apiKey = options.apiKey ?? env.OPENCODE_API_KEY;

  if (apiKey === undefined || apiKey.length === 0) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delay ?? sleep;
  const modelSelector = options.modelSelector ?? getSummaryModelSelector();
  const input = buildAiSummaryInput(events, options.pullRequestDetails ?? new Map());
  // One digest is one conversation, so retries reuse the ID and the next digest gets a new one.
  const sessionId = crypto.randomUUID();
  // Selection can probe models once a day; that wait does not count against the retry budget.
  const model = await modelSelector.getModel();

  const startedAt = Date.now();
  let attempts = 0;
  let lastStatus: number | null = null;

  while (true) {
    attempts += 1;

    try {
      const response = await sendSummaryRequest(fetchImpl, model, input, apiKey, sessionId);

      lastStatus = response.status;

      if (response.status === 429 || response.status >= 500) {
        const retryDelayMs = retryDelayFor(attempts, response, startedAt);

        if (retryDelayMs === null) {
          logger.warn(
            { model: model.id, status: response.status, attempts, event_count: events.length },
            "ai summary request failed"
          );
          incrementAiSummary("error");

          return null;
        }

        logger.debug(
          { model: model.id, attempt: attempts, status: response.status },
          "ai summary request failed, retrying"
        );

        await delay(retryDelayMs);

        continue;
      }

      if (!response.ok) {
        logger.warn(
          { model: model.id, status: response.status, event_count: events.length },
          "ai summary request failed"
        );

        if (isModelRejection(response.status)) {
          modelSelector.reportFailure(model.id);
        }

        incrementAiSummary("error");

        return null;
      }

      const completion = parseCompletion(model.protocol, await response.json());
      const text = completion?.text.trim() ?? "";

      if (completion !== null && !completion.complete) {
        logger.warn(
          {
            model: model.id,
            stop_reason: completion.stopReason,
            content_length: text.length,
            event_count: events.length
          },
          "ai summary response was incomplete"
        );
        modelSelector.reportFailure(model.id);
        incrementAiSummary("error");

        return null;
      }

      if (text.length === 0) {
        const retryDelayMs = retryDelayFor(attempts, null, startedAt);

        if (retryDelayMs === null) {
          logger.warn(
            { model: model.id, attempts, event_count: events.length },
            "ai summary response was empty"
          );
          modelSelector.reportFailure(model.id);
          incrementAiSummary("error");

          return null;
        }

        logger.debug(
          { model: model.id, attempt: attempts },
          "ai summary response was empty, retrying"
        );

        await delay(retryDelayMs);

        continue;
      }

      incrementAiSummary("ok");

      return text.length > maxSummaryChars
        ? `${text.slice(0, maxSummaryChars - 1).trimEnd()}…`
        : text;
    } catch (error) {
      const retryDelayMs = retryDelayFor(attempts, null, startedAt);

      if (retryDelayMs === null) {
        logger.warn(
          {
            err: error,
            model: model.id,
            attempts,
            last_status: lastStatus,
            event_count: events.length
          },
          "ai summary request errored"
        );
        incrementAiSummary("error");

        return null;
      }

      logger.debug({ attempt: attempts, err: error }, "ai summary request errored, retrying");

      await delay(retryDelayMs);

      continue;
    }
  }
};
