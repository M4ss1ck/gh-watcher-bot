// Sends sample rich digests to one chat for manual checks and PR screenshots.
// Usage: bun run scripts/send-rich-samples.ts --chat=<chat_id> [--only=one,several,split,ai,fallback]
import { createBot } from "~/bot";
import { renderAiDigest, renderEventDigest } from "~/formatting/render";
import { renderRichAiDigest, renderRichEventDigest } from "~/formatting/rich";
import type { StoredEvent } from "~/github/types";
import { logger } from "~/lib/logger";
import { createDeliveryTransport, sendDigest, type Digest } from "~/scheduler/deliverer";
import { fixtureEvents, pullRequestEvent, pushEvent } from "~/test/fixtures/github-events";

const args = new Map(
  Bun.argv.slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value] = arg.slice(2).split("=", 2);
      return [key, value ?? "true"] as const;
    })
);

const chatId = Number(args.get("chat"));

if (!Number.isSafeInteger(chatId)) {
  throw new Error("pass --chat=<telegram chat id>");
}

const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
const richOptions = { login: "octocat", since };
const otherRepo: StoredEvent = { ...pushEvent, id: "sample-other", repoName: "octocat/other" };
const manyPushes = Array.from({ length: 200 }, (_, index): StoredEvent => ({
  ...pushEvent,
  id: `sample-${index}`,
  createdAt: new Date(pushEvent.createdAt.getTime() + index * 1000)
}));
const aiSummaries = new Map([
  [pushEvent.repoName, "Fixed an edge case in the parser and added tests.\nAlso tagged a new release."],
  [otherRepo.repoName, "Small cleanup push, no behavior change."]
]);

const standard = (events: StoredEvent[]): Digest => ({
  rich: renderRichEventDigest(events, richOptions),
  html: renderEventDigest(events)
});

const samples: Record<string, Digest> = {
  one: standard(fixtureEvents),
  several: standard([pushEvent, pullRequestEvent, otherRepo]),
  split: standard(manyPushes),
  ai: {
    rich: renderRichAiDigest(aiSummaries, [pushEvent, otherRepo], richOptions),
    html: renderAiDigest(aiSummaries)
  },
  // An unknown tag makes Telegram reject the first part, which exercises the HTML fallback.
  fallback: {
    rich: ["<tg-not-a-tag>forced fallback</tg-not-a-tag>"],
    html: renderEventDigest([pushEvent])
  }
};

const selected = (args.get("only") ?? Object.keys(samples).join(",")).split(",");
const transport = createDeliveryTransport(createBot().api);

for (const name of selected) {
  const digest = samples[name];

  if (digest === undefined) {
    throw new Error(`unknown sample ${name}`);
  }

  const sent = await sendDigest(transport, chatId, digest, logger);
  logger.info({ sample: name, format: sent.format, message_count: sent.messageCount }, "sample sent");
}
