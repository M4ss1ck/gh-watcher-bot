// Verifies Telegram rich message rendering and splitting for digests.
import { describe, expect, test } from "bun:test";

import {
  countRichBlocks,
  renderRichAiDigest,
  renderRichEventDigest,
  richMessageLimits
} from "~/formatting/rich";
import type { StoredEvent } from "~/github/types";
import {
  fixtureEvents,
  pullRequestEvent,
  pushEvent,
  releaseEvent
} from "~/test/fixtures/github-events";

const since = new Date("2026-05-20T11:00:00Z");
const base = { login: "octocat", since };

const otherRepoPush: StoredEvent = {
  ...pushEvent,
  id: "push-other",
  repoName: "octocat/other"
};

const manyPushes = (repoName: string, count: number): StoredEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    ...pushEvent,
    id: `${repoName}-${index}`,
    repoName,
    createdAt: new Date(pushEvent.createdAt.getTime() + index * 1000)
  }));

const balanced = (html: string, tag: string): boolean =>
  (html.match(new RegExp(`<${tag}[ >]`, "gu"))?.length ?? 0) ===
  (html.match(new RegExp(`</${tag}>`, "gu"))?.length ?? 0);

const expectValidParts = (
  parts: string[],
  limits: { maxCharacters: number; maxBlocks: number }
): void => {
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(limits.maxCharacters);
    expect(countRichBlocks(part)).toBeLessThanOrEqual(limits.maxBlocks);
    expect(part.startsWith("<h3>@octocat · GitHub activity</h3>")).toBe(true);
    for (const tag of ["details", "summary", "ul", "li", "p", "a"]) {
      expect(balanced(part, tag)).toBe(true);
    }
  }
};

describe("countRichBlocks", () => {
  // Each case is the largest unit count the live Bot API accepted under its
  // 500-block limit, so the counter must give <= 500 there and > 500 at n + 1.
  test.each([
    ["flat list items", (n: number) => `<ul>${"<li>x</li>".repeat(n)}</ul>`, 499],
    ["paragraphs", (n: number) => "<p>x</p>".repeat(n), 500],
    ["items with text before a nested list", (n: number) => `<ul>${"<li>x<ul><li>a</li><li>b</li></ul></li>".repeat(n)}</ul>`, 99],
    ["details sections", (n: number) => '<details><summary><a href="https://github.com/r">r</a> · 1</summary><ul><li>x</li></ul></details>'.repeat(n), 166]
  ])("matches Telegram's count for %s", (_name, build, maxAccepted) => {
    expect(countRichBlocks(build(maxAccepted))).toBeLessThanOrEqual(500);
    expect(countRichBlocks(build(maxAccepted + 1))).toBeGreaterThan(500);
  });

  test("counts block elements and list items but not inline tags or escaped text", () => {
    expect(
      countRichBlocks("<h3>t</h3><p>a <b>b</b> &lt;p&gt;</p><ul><li>x</li><li>y</li></ul>")
    ).toBe(5);
  });
});

describe("renderRichEventDigest", () => {
  test("renders one repository as an open section with nested commit lists", () => {
    expect(renderRichEventDigest([pushEvent, releaseEvent], base)).toEqual([
      [
        "<h3>@octocat · GitHub activity</h3>",
        "<p>since <tg-time unix=\"1779274800\" format=\"r\">2026-05-20 11:00 UTC</tg-time></p>",
        "<details open><summary><a href=\"https://github.com/octocat/hello-world\">octocat/hello-world</a> · 1 push, 1 release</summary>",
        "<ul>",
        "<li><a href=\"https://github.com/octocat\">octocat</a> <a href=\"https://github.com/octocat/hello-world/commit/abc123456789\">pushed 2 commits to main</a>",
        "<ul><li>Fix parser &lt;edge&gt;</li><li>Add tests &amp; docs</li></ul></li>",
        "<li><a href=\"https://github.com/release-bot%5Bbot%5D\">release-bot[bot]</a> <a href=\"https://github.com/octocat/hello-world/releases/tag/v1.2.3\">published release Version &lt;1.2.3&gt;</a></li>",
        "</ul></details>",
        "<footer>Manage with /subscribe</footer>"
      ].join("")
    ]);
  });

  test("collapses every section when the digest covers several repositories", () => {
    const parts = renderRichEventDigest([pushEvent, pullRequestEvent, otherRepoPush], base);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchSnapshot();
    expect(parts[0]).not.toContain("<details open>");
    expect(parts[0]?.match(/<details>/gu)).toHaveLength(2);
    expect(parts[0]).toContain("octocat/hello-world</a> · 1 push, 1 PR opened</summary>");
  });

  test("omits the since line on a first delivery", () => {
    const [part] = renderRichEventDigest([pushEvent], { login: "octocat", since: null });

    expect(part).not.toContain("tg-time");
  });

  test("escapes user strings in text and attributes", () => {
    const hostile: StoredEvent = {
      ...releaseEvent,
      repoName: "evil/\"><b>repo",
      actorLogin: "a<b>&\"c",
      payload: { action: "published", release: { name: "<script>", html_url: "https://x.test/\"onload=\"" } }
    };
    const [part] = renderRichEventDigest([hostile], base);

    expect(part).not.toContain("<script>");
    expect(part).not.toContain("\"onload=\"");
    expect(part).not.toContain("<b>repo");
    expect(part).toContain("&lt;script&gt;");
  });

  test("lists every event type found in the fixtures", () => {
    const [part] = renderRichEventDigest(fixtureEvents, base);

    expect(part).toMatchSnapshot();
    expect(part).toContain(
      "· 1 push, 1 PR opened, 1 release, 1 star, 1 fork, 1 branch created</summary>"
    );
  });

  test("splits at repository boundaries under the character limit and repeats the title", () => {
    const limits = { maxCharacters: 1200, maxBlocks: richMessageLimits.maxBlocks };
    const events = [
      ...manyPushes("octocat/one", 2),
      ...manyPushes("octocat/two", 2),
      ...manyPushes("octocat/three", 2)
    ];
    const parts = renderRichEventDigest(events, { ...base, limits });

    expect(parts.length).toBeGreaterThan(1);
    expectValidParts(parts, limits);
    for (const part of parts) {
      // No repository is cut in half when each fits on its own.
      expect(part).not.toContain("(continued)");
    }
    expect(parts.join("").match(/<details>/gu)).toHaveLength(3);
    expect(parts.map((part) => part.includes("<footer>"))).toEqual(
      parts.map((_, index) => index === parts.length - 1)
    );
    expect(parts).toMatchSnapshot();
  });

  test("splits a single oversized repository across parts only as a last resort", () => {
    const limits = { maxCharacters: 1500, maxBlocks: richMessageLimits.maxBlocks };
    const parts = renderRichEventDigest(manyPushes("octocat/big", 12), { ...base, limits });

    expect(parts.length).toBeGreaterThan(1);
    expectValidParts(parts, limits);
    expect(parts.slice(1).every((part) => part.includes("(continued)</summary>"))).toBe(true);
    expect(parts.every((part) => part.includes("<details open>"))).toBe(true);
    expect(parts.join("").match(/>pushed 2 commits to main</gu)).toHaveLength(12);
  });

  test("splits under the block limit even when characters fit", () => {
    const limits = { maxCharacters: richMessageLimits.maxCharacters, maxBlocks: 40 };
    const events = [
      ...manyPushes("octocat/one", 5),
      ...manyPushes("octocat/two", 5),
      ...manyPushes("octocat/three", 5)
    ];
    const parts = renderRichEventDigest(events, { ...base, limits });

    expect(parts.length).toBeGreaterThan(1);
    expectValidParts(parts, limits);
    expect(parts.join("").match(/>pushed 2 commits to main</gu)).toHaveLength(15);
    expect(parts).toMatchSnapshot();
  });

  test("keeps the default limits for a realistic large digest in one message", () => {
    const parts = renderRichEventDigest(manyPushes("octocat/hello-world", 60), base);

    expect(parts).toHaveLength(1);
    expectValidParts(parts, richMessageLimits);
  });

  test("splits at the real Bot API limits and keeps every event", () => {
    const events = [...manyPushes("octocat/one", 150), ...manyPushes("octocat/two", 150)];
    const parts = renderRichEventDigest(events, base);

    // 150 pushes are about 600 blocks, so each repo is cut once: the first
    // chunk fills a part to the block limit, the rest goes in the next part.
    expect(parts).toHaveLength(4);
    expectValidParts(parts, richMessageLimits);
    expect(countRichBlocks(parts[0] ?? "")).toBeGreaterThan(richMessageLimits.maxBlocks - 10);
    expect(parts[2]).toContain("octocat/two</a> · 150 pushes</summary>");
    expect(parts.join("").match(/>pushed 2 commits to main</gu)).toHaveLength(300);
  });

  test("caps commit lines per push and counts the rest", () => {
    const bigPush: StoredEvent = {
      ...pushEvent,
      payload: {
        ref: "refs/heads/main",
        size: 7,
        commits: Array.from({ length: 7 }, (_, index) => ({
          message: `Commit ${index}\n\nlong body that should not show`
        }))
      }
    };
    const [part] = renderRichEventDigest([bigPush], base);

    expect(part).toContain("<li>Commit 0</li><li>Commit 1</li><li>Commit 2</li><li>+4 more</li>");
    expect(part).not.toContain("long body");
  });

  test("returns no parts for no events", () => {
    expect(renderRichEventDigest([], base)).toEqual([]);
  });
});

describe("renderRichAiDigest", () => {
  test("renders model prose as escaped paragraphs inside an open section", () => {
    const parts = renderRichAiDigest(
      new Map([[pushEvent.repoName, "Shipped <v2> & more.\n\nAlso fixed a bug."]]),
      [pushEvent, releaseEvent],
      base
    );

    expect(parts).toEqual([
      [
        "<h3>@octocat · GitHub activity</h3>",
        "<p>since <tg-time unix=\"1779274800\" format=\"r\">2026-05-20 11:00 UTC</tg-time></p>",
        "<details open><summary><a href=\"https://github.com/octocat/hello-world\">octocat/hello-world</a> · 1 push, 1 release</summary>",
        "<p>Shipped &lt;v2&gt; &amp; more.</p><p>Also fixed a bug.</p>",
        "</details>",
        "<footer>Manage with /subscribe</footer>"
      ].join("")
    ]);
  });

  test("collapses sections for several repositories", () => {
    const parts = renderRichAiDigest(
      new Map([
        [pushEvent.repoName, "First repo changed."],
        [otherRepoPush.repoName, "Second repo changed."]
      ]),
      [pushEvent, otherRepoPush],
      base
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchSnapshot();
    expect(parts[0]?.match(/<details>/gu)).toHaveLength(2);
  });

  test("splits long prose by characters and by blocks", () => {
    const prose = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} with some words.`).join("\n");
    const summaries = new Map([
      ["octocat/one", prose],
      ["octocat/two", prose]
    ]);
    const events = [...manyPushes("octocat/one", 1), ...manyPushes("octocat/two", 1)];

    for (const limits of [
      { maxCharacters: 1200, maxBlocks: richMessageLimits.maxBlocks },
      { maxCharacters: richMessageLimits.maxCharacters, maxBlocks: 25 }
    ]) {
      const parts = renderRichAiDigest(summaries, events, { ...base, limits });

      expect(parts.length).toBeGreaterThan(1);
      expectValidParts(parts, limits);
      expect(parts.join("").match(/<p>Paragraph \d+ /gu)).toHaveLength(80);
    }
  });
});
