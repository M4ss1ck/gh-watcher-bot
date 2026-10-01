// Verifies Telegram HTML rendering for event digests.
import { describe, expect, test } from "bun:test";

import {
  renderAccountSummary,
  renderAiDigest,
  renderEventDigest
} from "~/formatting/render";
import { summarizeEvent } from "~/formatting/summarize";
import type { StoredEvent } from "~/github/types";
import {
  fixtureEvents,
  pullRequestEvent,
  pushEvent,
  releaseEvent
} from "~/test/fixtures/github-events";

describe("summarizeEvent", () => {
  test("summarizes noisy push commits", () => {
    expect(summarizeEvent(pushEvent)).toEqual({
      title: "pushed 2 commits to main",
      detail: "Fix parser <edge>; Add tests & docs",
      url: "https://github.com/octocat/hello-world/commit/abc123456789",
      extra: []
    });
  });

  test("summarizes pull requests and releases", () => {
    expect(summarizeEvent(pullRequestEvent).title).toBe(
      "opened pull request #42"
    );
    expect(summarizeEvent(releaseEvent).title).toBe(
      "published release Version <1.2.3>"
    );
  });

  test("derives a URL and branch detail when public events strip pull_request title", () => {
    const stripped: StoredEvent = {
      id: "pr-stripped",
      accountId: 1,
      type: "PullRequestEvent",
      repoName: "M4ss1ck/anime-bot",
      actorLogin: "M4ss1ck",
      payload: {
        action: "merged",
        number: 2,
        pull_request: {
          url: "https://api.github.com/repos/M4ss1ck/anime-bot/pulls/2",
          id: 3672247585,
          number: 2,
          head: { ref: "feat/migrate-to-grammy" },
          base: { ref: "master" }
        }
      },
      createdAt: new Date("2026-05-20T12:00:00Z")
    };

    expect(summarizeEvent(stripped)).toEqual({
      title: "merged pull request #2",
      detail: "feat/migrate-to-grammy → master",
      url: "https://github.com/M4ss1ck/anime-bot/pull/2",
      extra: []
    });
  });

  test("uses pull request enrichment when provided", () => {
    const event: StoredEvent = {
      id: "pr-enriched",
      accountId: 1,
      type: "PullRequestEvent",
      repoName: "M4ss1ck/maibuk",
      actorLogin: "M4ss1ck",
      payload: {
        action: "merged",
        number: 39,
        pull_request: {
          url: "https://api.github.com/repos/M4ss1ck/maibuk/pulls/39",
          number: 39,
          head: { ref: "feat/paste-cleanup" },
          base: { ref: "main" }
        }
      },
      createdAt: new Date("2026-05-20T12:00:00Z")
    };

    const summary = summarizeEvent(event, {
      pullRequestDetail: {
        number: 39,
        title: "Clean up paste handler",
        body: "Fix flicker when pasting long text.",
        htmlUrl: "https://github.com/M4ss1ck/maibuk/pull/39",
        merged: true,
        mergedBy: "M4ss1ck",
        additions: 42,
        deletions: 7,
        changedFiles: 3,
        commits: 5
      }
    });

    expect(summary.title).toBe("merged pull request #39");
    expect(summary.detail).toBe("Clean up paste handler (feat/paste-cleanup → main)");
    expect(summary.url).toBe("https://github.com/M4ss1ck/maibuk/pull/39");
    expect(summary.extra).toEqual([
      "+42 −7 across 3 files · 5 commits",
      "merged by M4ss1ck",
      "Fix flicker when pasting long text."
    ]);
  });
});

describe("renderEventDigest", () => {
  test("groups events under a single repo header with linked user and repo", () => {
    expect(renderEventDigest([pushEvent, releaseEvent])).toEqual([
      [
        "<b>GitHub activity digest</b>",
        "",
        "<b><a href=\"https://github.com/octocat/hello-world\">octocat/hello-world</a></b>",
        "<blockquote expandable>• <a href=\"https://github.com/octocat\">octocat</a> pushed 2 commits to main",
        "  Fix parser &lt;edge&gt;; Add tests &amp; docs",
        "• <a href=\"https://github.com/release-bot%5Bbot%5D\">release-bot[bot]</a> published release Version &lt;1.2.3&gt;</blockquote>"
      ].join("\n")
    ]);
  });

  test("repeats the repo header on each message when events for one repo span a split", () => {
    const messages = renderEventDigest(fixtureEvents, { maxMessageLength: 400 });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 400)).toBe(true);
    expect(
      messages.every((message) =>
        message.includes(
          "<b><a href=\"https://github.com/octocat/hello-world\">octocat/hello-world</a></b>"
        )
      )
    ).toBe(true);
    expect(messages.every((message) => message.includes("<blockquote expandable>"))).toBe(true);
  });

  test("groups two repositories into independently expandable sections", () => {
    const secondRepo = { ...pushEvent, id: "other", repoName: "octocat/other" };
    const [message] = renderEventDigest([pushEvent, secondRepo]);

    expect(message.match(/<blockquote expandable>/gu)).toHaveLength(2);
    expect(message.match(/<\/blockquote>/gu)).toHaveLength(2);
    expect(message).toContain("octocat/other</a></b>\n<blockquote expandable>");
  });

  test("splits an oversized event into valid quoted messages without losing text", () => {
    const marker = "x".repeat(1200);
    const longEvent = {
      ...releaseEvent,
      payload: { action: "published", release: { name: marker, tag_name: "v1" } }
    };
    const messages = renderEventDigest([longEvent], { maxMessageLength: 400 });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 400)).toBe(true);
    expect(messages.every((message) => message.includes("<blockquote expandable>"))).toBe(true);
    expect(messages.every((message) =>
      (message.match(/<blockquote expandable>/gu)?.length ?? 0) ===
      (message.match(/<\/blockquote>/gu)?.length ?? 0)
    )).toBe(true);
    expect(messages.join("").match(/x{10,}/gu)?.join("")).toHaveLength(1200);
  });
});

describe("renderAiDigest", () => {
  test("escapes the summary and links each repository", () => {
    const [message] = renderAiDigest(new Map([[pushEvent.repoName, "Shipped <v2> & more"]]));

    expect(message).toContain("<b>GitHub activity digest</b>");
    expect(message).toContain("Shipped &lt;v2&gt; &amp; more");
    expect(message).toContain(`https://github.com/${pushEvent.repoName}`);
    expect(message).not.toContain("<v2>");
  });

  test("returns exactly one message for a short summary", () => {
    const messages = renderAiDigest(new Map([[pushEvent.repoName, "Shipped <v2> & more"]]));

    expect(messages).toEqual([
      [
        "<b>GitHub activity digest</b> · AI summary",
        "",
        `<b><a href="https://github.com/octocat/hello-world">octocat/hello-world</a></b>`,
        "<blockquote expandable>Shipped &lt;v2&gt; &amp; more</blockquote>"
      ].join("\n")
    ]);
  });

  test("splits a long summary across messages within the budget", () => {
    const longSummary = Array.from(
      { length: 30 },
      (_, index) => `Line ${index}: some text here`
    ).join("\n");
    const messages = renderAiDigest(new Map([[pushEvent.repoName, longSummary]]), { maxMessageLength: 250 });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 250)).toBe(true);
  });

  test("repeats the header and repo label after a split", () => {
    const messages = renderAiDigest(new Map([[pushEvent.repoName, "line\n".repeat(50)]]), { maxMessageLength: 250 });

    expect(messages.every((message) => message.includes("<b>GitHub activity digest</b>"))).toBe(true);
    expect(messages.every((message) => message.includes(pushEvent.repoName))).toBe(true);
  });

  test("keeps each repository's prose in its own quote", () => {
    const messages = renderAiDigest(new Map([
      [pushEvent.repoName, "First repo changed."],
      ["octocat/other", "Second repo changed."]
    ]));

    expect(messages).toHaveLength(1);
    expect(messages[0].match(/<blockquote expandable>/gu)).toHaveLength(2);
    expect(messages[0]).toContain("First repo changed.</blockquote>");
    expect(messages[0]).toContain("Second repo changed.</blockquote>");
  });

  test("hard-splits a single line longer than the budget", () => {
    const messages = renderAiDigest(new Map([[pushEvent.repoName, "word ".repeat(100)]]), { maxMessageLength: 250 });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 250)).toBe(true);
  });

  test("never splits inside an escaped entity", () => {
    const messages = renderAiDigest(new Map([[pushEvent.repoName, `${"x".repeat(200)}&y`]]), {
      maxMessageLength: 250
    });

    expect(
      messages.every((message) => !message.includes("&") || message.includes("&amp;"))
    ).toBe(true);
  });
});

describe("renderAccountSummary", () => {
  test("renders escaped account metadata and subscription defaults", () => {
    expect(
      renderAccountSummary(
        {
          id: 583231,
          login: "octocat",
          name: "The <Octocat>",
          bio: null,
          publicRepos: 8,
          followers: 12_345,
          htmlUrl: "https://github.com/octocat?tab=<overview>"
        },
        {
          schedulePreset: "hourly",
          timezone: "UTC",
          preset: "firehose"
        }
      )
    ).toBe(
      [
        "<b>Watching <code>@octocat</code></b> · <a href=\"https://github.com/octocat?tab=&lt;overview&gt;\">profile</a>",
        "The &lt;Octocat&gt; · 8 public repos · 12k followers",
        "Schedule: Hourly (UTC) · Preset: Firehose",
        "Tap /subscribe to manage."
      ].join("\n")
    );
  });
});
