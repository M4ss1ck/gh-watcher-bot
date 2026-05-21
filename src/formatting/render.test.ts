// Verifies Telegram HTML rendering for event digests.
import { describe, expect, test } from "bun:test";

import { renderAccountSummary, renderEventDigest } from "~/formatting/render";
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
      url: "https://github.com/M4ss1ck/anime-bot/pull/2"
    });
  });
});

describe("renderEventDigest", () => {
  test("groups events under a single repo header with linked user and repo", () => {
    expect(renderEventDigest([pushEvent, releaseEvent])).toEqual([
      [
        "<b>GitHub activity digest</b>",
        "",
        "<b><a href=\"https://github.com/octocat/hello-world\">octocat/hello-world</a></b>",
        "• <a href=\"https://github.com/octocat\">octocat</a> pushed 2 commits to main",
        "  Fix parser &lt;edge&gt;; Add tests &amp; docs",
        "  <a href=\"https://github.com/octocat/hello-world/commit/abc123456789\">Open on GitHub</a>",
        "• <a href=\"https://github.com/release-bot%5Bbot%5D\">release-bot[bot]</a> published release Version &lt;1.2.3&gt;",
        "  <a href=\"https://github.com/octocat/hello-world/releases/tag/v1.2.3\">Open on GitHub</a>"
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
        "Schedule: hourly (UTC) · Preset: firehose",
        "Tap /subscribe to manage."
      ].join("\n")
    );
  });
});
