// Picks the AI summary model against the live catalog, writes one digest with it, and checks the result.
import { fallbackModel, loadRankedModels } from "~/ai/models";
import { generateAiSummary, getSummaryModelSelector } from "~/ai/summary";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { pullRequestEvent, pushEvent, releaseEvent } from "~/test/fixtures/github-events";

const apiKey = env.OPENCODE_API_KEY;

if (apiKey === undefined || apiKey.length === 0) {
  logger.error("OPENCODE_API_KEY is not set");
  process.exit(1);
}

const ranked = await loadRankedModels({ fetchImpl: fetch, apiKey });

console.log("Cheapest eligible models:");
for (const model of ranked.slice(0, 8)) {
  console.log(
    `  ${model.id.padEnd(32)} ${model.protocol.padEnd(9)} $${model.costPerDigestUsd.toFixed(6)}/digest`
  );
}

const selector = getSummaryModelSelector();
const model = await selector.getModel();
const selection = selector.currentSelection();

console.log(`\nSelected: ${model.id} (${selection?.reason})`);

const events = [pushEvent, pullRequestEvent, releaseEvent];
const startedAt = Date.now();
const summary = await generateAiSummary(events, { apiKey, modelSelector: selector });

console.log(`\nSummary in ${Date.now() - startedAt}ms:\n${summary ?? "(none)"}\n`);

const repoNames = new Set(events.map((event) => event.repoName));
const sentences = (summary ?? "").split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0);
const checks: [string, boolean][] = [
  ["a summary came back", summary !== null],
  ["the pick is the cheapest eligible model", model.id === ranked[0]?.id],
  ["the pick is not the fallback", model.id !== fallbackModel.id || ranked[0]?.id === fallbackModel.id],
  ["no more than 6 sentences", sentences.length <= 6],
  [
    "every sentence starts with a repository name",
    sentences.every((sentence) => [...repoNames].some((name) => sentence.startsWith(name)))
  ],
  ["plain text, no markdown bullets or headings", !/^\s*([-*#]|\d+\.)\s/m.test(summary ?? "")]
];

for (const [name, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}

process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
