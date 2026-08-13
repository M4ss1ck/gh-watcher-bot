// Generates prose digest summaries through the opencode Go chat completions API.
import type { GitHubPullRequestDetail, StoredEvent } from "~/github/types";
import { summarizeEvent } from "~/formatting/summarize";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { incrementAiSummary } from "~/lib/metrics";

const apiUrl = "https://opencode.ai/zen/go/v1/chat/completions";
const model = "deepseek-v4-flash";
export const requestTimeoutMs = 12_000;
const maxInputChars = 24_000;
const maxSummaryChars = 3_000;
const minSummaryTokens = 100;
const maxSummaryTokens = 400;
const summaryBaseTokens = 60;
const summaryTokensPerRepo = 40;
export const maxAttempts = 3;
const retryBackoffMs = [1_000, 2_000];
const maxJitterMs = 250;
const maxRetryAfterMs = 5_000;
export const totalBudgetMs = 40_000;

const systemPrompt = `You summarize GitHub activity for a Telegram digest bot.

Rules:
- Plain text only. No markdown, no HTML, no headings, no bullet points.
- Write ONE sentence per repository. Never more than 4 sentences in total.
- If there is only one event, write ONE short sentence and stop.
- Start each sentence with the repository name.
- Use active voice and always name the person who did it. Never write "a branch was created" without saying who created it.
- State only what happened. Never explain why it matters, what it indicates, what it means, or what is most notable.
- Never write a closing, completion, or summarising sentence.
- Collapse a chain of related events into its end state. A branch created, then a pull request opened from it, then that pull request merged, is ONE fact: the merge. Do not narrate the sequence that led there.
- Do not restate the same fact at different levels of detail.
- Banned phrasings, including anything similar: "saw activity", "the most notable", "this indicates", "which means", "overall", "in summary", "notably", "completing the change", "subsequently", "followed by".
- Do not invent anything absent from the input.

Examples:
bad: M4ss1ck/maibuk saw activity around a new branch and pull request. M4ss1ck created the branch M4ss1ck/projects-archive-books, then opened and later merged pull request #143, which brings that branch into the main branch. The merge is the most notable change, indicating the projects-archive-books work is now part of the main codebase.
good: M4ss1ck/maibuk: M4ss1ck merged PR #143 (projects-archive-books) into main.

bad: In M4ss1ck/maibuk, a new branch M4ss1ck/better-canvas was created, followed by pull request #142 from that branch into main. The pull request was subsequently opened and then merged, completing the change.
good: M4ss1ck/maibuk: M4ss1ck merged PR #142 (better-canvas) into main.`;

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type DelayFn = (ms: number) => Promise<void>;

export type GenerateAiSummaryOptions = {
  pullRequestDetails?: Map<string, GitHubPullRequestDetail>;
  fetchImpl?: FetchImpl;
  apiKey?: string;
  delay?: DelayFn;
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

export const summaryTokenBudget = (events: StoredEvent[]): number => {
  const repoCount = new Set(events.map((event) => event.repoName)).size;

  return Math.min(
    Math.max(summaryBaseTokens + summaryTokensPerRepo * repoCount, minSummaryTokens),
    maxSummaryTokens
  );
};

export const buildAiSummaryInput = (
  events: StoredEvent[],
  pullRequestDetails: Map<string, GitHubPullRequestDetail>
): string => {
  const byRepo = new Map<string, string[]>();

  for (const event of events) {
    const summary = summarizeEvent(event, {
      pullRequestDetail: pullRequestDetails.get(event.id) ?? null
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

const extractCompletionText = (data: unknown): string | null => {
  if (typeof data !== "object" || data === null || !("choices" in data)) {
    return null;
  }

  const choices = (data as { choices: unknown }).choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const first = choices[0] as { message?: { content?: unknown } };
  const content = first.message?.content;

  return typeof content === "string" ? content : null;
};

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
  const input = buildAiSummaryInput(events, options.pullRequestDetails ?? new Map());
  const maxTokens = summaryTokenBudget(events);

  const startedAt = Date.now();
  let attempts = 0;
  let lastStatus: number | null = null;

  while (true) {
    attempts += 1;

    try {
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: input }
          ],
          temperature: 0.2,
          max_tokens: maxTokens
        }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });

      lastStatus = response.status;

      if (response.status === 429 || response.status >= 500) {
        const retryDelayMs = retryDelayFor(attempts, response, startedAt);

        if (retryDelayMs === null) {
          logger.warn(
            { status: response.status, attempts, event_count: events.length },
            "ai summary request failed"
          );
          incrementAiSummary("error");

          return null;
        }

        logger.debug(
          { attempt: attempts, status: response.status },
          "ai summary request failed, retrying"
        );

        await delay(retryDelayMs);

        continue;
      }

      if (!response.ok) {
        logger.warn(
          { status: response.status, event_count: events.length },
          "ai summary request failed"
        );
        incrementAiSummary("error");

        return null;
      }

      const text = extractCompletionText(await response.json())?.trim() ?? "";

      if (text.length === 0) {
        const retryDelayMs = retryDelayFor(attempts, null, startedAt);

        if (retryDelayMs === null) {
          logger.warn({ attempts, event_count: events.length }, "ai summary response was empty");
          incrementAiSummary("error");

          return null;
        }

        logger.debug({ attempt: attempts }, "ai summary response was empty, retrying");

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
          { err: error, attempts, last_status: lastStatus, event_count: events.length },
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
