// Picks the AI summary model against the live catalog and checks repository summaries.
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
    `  ${model.id.padEnd(32)} ${model.protocol.padEnd(9)} $${model.costPerSummaryUsd.toFixed(6)}/repo summary`
  );
}

const selector = getSummaryModelSelector();
const model = await selector.getModel();
const selection = selector.currentSelection();

console.log(`\nSelected: ${model.id} (${selection?.reason})`);

const cases = [
  { name: "push and release", events: [pushEvent, releaseEvent] },
  { name: "pull request", events: [pullRequestEvent] }
];
const selectedRank = ranked.findIndex((candidate) => candidate.id === model.id);
const checks: [string, boolean][] = [
  [
    "the selection reason matches the model rank",
    (selection?.reason === "cheapest" && selectedRank === 0) ||
      (selection?.reason === "cheaper-model-failed" && selectedRank > 0) ||
      (selection?.reason === "fallback" && model.id === fallbackModel.id)
  ]
];

for (const { name, events } of cases) {
  const startedAt = Date.now();
  const summary = await generateAiSummary(events, { apiKey, modelSelector: selector });
  console.log(`\n${name} in ${Date.now() - startedAt}ms:\n${summary ?? "(none)"}\n`);

  const repoName = events[0]!.repoName;
  const sentences = (summary ?? "").split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0);
  checks.push(
    [`${name}: a summary came back`, summary !== null],
    [`${name}: no more than 6 sentences`, sentences.length <= 6],
    [`${name}: repository label is not repeated`, !summary?.includes(repoName)],
    [`${name}: plain text, no markdown bullets or headings`, !/^\s*([-*#]|\d+\.)\s/m.test(summary ?? "")]
  );
}

for (const [name, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}

process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
