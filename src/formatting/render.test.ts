// Verifies Telegram HTML rendering for event digests.
import { describe, expect, test } from "bun:test";

import { renderAccountSummary, renderEventDigest } from "~/formatting/render";
import { summarizeEvent } from "~/formatting/summarize";
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
      url: "https://github.com/octocat/hello-world/commit/abc123456789"
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
});

describe("renderEventDigest", () => {
  test("renders escaped Telegram HTML", () => {
    expect(renderEventDigest([pushEvent, releaseEvent])).toEqual([
      [
        "<b>GitHub activity digest</b>",
        "",
        "• <b>octocat/hello-world</b> · octocat pushed 2 commits to main",
        "  Fix parser &lt;edge&gt;; Add tests &amp; docs",
        "  <a href=\"https://github.com/octocat/hello-world/commit/abc123456789\">Open on GitHub</a>",
        "",
        "• <b>octocat/hello-world</b> · release-bot[bot] published release Version &lt;1.2.3&gt;",
        "  <a href=\"https://github.com/octocat/hello-world/releases/tag/v1.2.3\">Open on GitHub</a>"
      ].join("\n")
    ]);
  });

  test("splits long digests into multiple Telegram messages", () => {
    const messages = renderEventDigest(fixtureEvents, { maxMessageLength: 300 });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 300)).toBe(true);
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
        "<b>Watching @octocat</b> · <a href=\"https://github.com/octocat?tab=&lt;overview&gt;\">profile</a>",
        "The &lt;Octocat&gt; · 8 public repos · 12k followers",
        "Schedule: hourly (UTC) · Preset: firehose",
        "Tap /subscribe to manage."
      ].join("\n")
    );
  });
});
