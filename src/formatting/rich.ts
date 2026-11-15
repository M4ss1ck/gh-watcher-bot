// Renders digests as Telegram rich messages (sendRichMessage HTML).
import type { GitHubPullRequestDetail, StoredEvent } from "~/github/types";
import { formatDateTimeInTimeZone } from "~/formatting/dates";
import { escapeAttribute, escapeHtml } from "~/formatting/render";
import { pushCommitLines, summarizeEvent } from "~/formatting/summarize";

export type RichMessageLimits = { maxCharacters: number; maxBlocks: number };

// Bot API rich message limits. Both counts below overestimate on purpose:
// characters include markup and count UTF-16 units, and blocks include every
// block-level tag, so a part that passes here is within Telegram's limits.
export const richMessageLimits: RichMessageLimits = {
  maxCharacters: 32_768,
  maxBlocks: 500
};

export type RichDigestOptions = {
  login: string;
  since: Date | null;
  limits?: RichMessageLimits;
  pullRequestDetails?: Map<string, GitHubPullRequestDetail>;
};

// Long single texts are clipped so one event can never outgrow a whole message.
const maxTextLength = 1_000;
const blockTagPattern = /<(?:h[1-6]|p|ul|ol|li|details|footer|blockquote|pre|table|tr|hr|aside)[\s>]/gu;
// Text right before a nested block (like "pushed 2 commits<ul>") is wrapped in an
// implicit paragraph that Telegram counts as one more block.
const implicitParagraphPattern = /(?:[^>]|<\/(?:a|b|i|u|s|em|strong|code|tg-time)>)<(?:ul|ol|p|blockquote|details|pre)[\s>]/gu;

// Matches limits probed against the live Bot API (Nov 2026): ul, li, p, details
// and footer count one each, summary counts none, and text followed by a nested
// list adds one. User text is escaped before it gets here, so "<" only starts markup.
export const countRichBlocks = (html: string): number =>
  (html.match(blockTagPattern)?.length ?? 0) +
  (html.match(implicitParagraphPattern)?.length ?? 0);

const clip = (value: string): string =>
  value.length <= maxTextLength ? value : `${value.slice(0, maxTextLength - 1).trimEnd()}…`;

const link = (url: string | null, text: string): string =>
  url !== null && /^https?:\/\//u.test(url)
    ? `<a href="${escapeAttribute(url)}">${escapeHtml(clip(text))}</a>`
    : escapeHtml(clip(text));

const repoLink = (repoName: string): string =>
  link(`https://github.com/${repoName}`, repoName);

const actorLink = (login: string): string =>
  link(`https://github.com/${encodeURIComponent(login)}`, login);

const renderHeader = (login: string, since: Date | null): string => {
  const title = `<h3>@${escapeHtml(login)} · GitHub activity</h3>`;

  if (since === null) {
    return title;
  }

  const unix = Math.floor(since.getTime() / 1000);
  const fallback = escapeHtml(formatDateTimeInTimeZone(since, "UTC"));

  return `${title}<p>since <tg-time unix="${unix}" format="r">${fallback}</tg-time></p>`;
};

const countLabel = (event: StoredEvent): [string, string] => {
  const action =
    typeof event.payload.action === "string" ? event.payload.action : "updated";

  switch (event.type) {
    case "PushEvent":
      return ["push", "pushes"];
    case "PullRequestEvent":
      return [`PR ${action}`, `PRs ${action}`];
    case "IssuesEvent":
      return [`issue ${action}`, `issues ${action}`];
    case "ReleaseEvent":
      return ["release", "releases"];
    case "WatchEvent":
      return ["star", "stars"];
    case "ForkEvent":
      return ["fork", "forks"];
    case "CreateEvent":
      if (event.payload.ref_type === "branch") {
        return ["branch created", "branches created"];
      }
      if (event.payload.ref_type === "tag") {
        return ["tag created", "tags created"];
      }
      return ["repository created", "repositories created"];
    case "RepositoryEvent":
      return [`repository ${action}`, `repositories ${action}`];
    default:
      return ["other event", "other events"];
  }
};

const formatCounts = (events: StoredEvent[]): string => {
  const counts = new Map<string, { plural: string; count: number }>();

  for (const event of events) {
    const [singular, plural] = countLabel(event);
    const existing = counts.get(singular);
    counts.set(singular, { plural, count: (existing?.count ?? 0) + 1 });
  }

  return [...counts]
    .map(([singular, { plural, count }]) => `${count} ${count === 1 ? singular : plural}`)
    .join(", ");
};

const renderEventItem = (
  event: StoredEvent,
  pullRequestDetail: GitHubPullRequestDetail | null
): string => {
  const summary = summarizeEvent(event, { pullRequestDetail });
  const nested: string[] = [];

  if (event.type === "PushEvent") {
    const commits = pushCommitLines(event);
    nested.push(...commits.lines);
    if (commits.lines.length > 0 && commits.remaining > 0) {
      nested.push(`+${commits.remaining} more`);
    }
  } else {
    if (summary.detail !== null) {
      nested.push(summary.detail);
    }
    nested.push(...summary.extra);
  }

  const nestedList =
    nested.length === 0
      ? ""
      : `<ul>${nested.map((line) => `<li>${escapeHtml(clip(line))}</li>`).join("")}</ul>`;

  return `<li>${actorLink(event.actorLogin)} ${link(summary.url, summary.title)}${nestedList}</li>`;
};

const paragraphs = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => `<p>${escapeHtml(clip(line))}</p>`);

type RepoSection = {
  repoName: string;
  counts: string;
  // Event items are <li> and need a <ul> around them; AI paragraphs stand alone.
  list: boolean;
  items: string[];
};

const groupByRepo = (events: StoredEvent[]): Map<string, StoredEvent[]> => {
  const grouped = new Map<string, StoredEvent[]>();

  for (const event of events) {
    const existing = grouped.get(event.repoName) ?? [];
    existing.push(event);
    grouped.set(event.repoName, existing);
  }

  return grouped;
};

type Part = { body: string; blocks: number };

const tooSmall = (): RangeError =>
  new RangeError("Rich message limits are too small for one digest item");

// Packs repo sections into as few messages as the limits allow. A section moves
// whole to the next message when it does not fit; it is cut only when it would
// not fit even an empty message.
const packSections = (sections: RepoSection[], options: RichDigestOptions): string[] => {
  const header = renderHeader(options.login, options.since);
  const limits = options.limits ?? richMessageLimits;
  const open = sections.length === 1 ? " open" : "";
  const charBudget = limits.maxCharacters - header.length;
  const blockBudget = limits.maxBlocks - countRichBlocks(header);
  const parts: Part[] = [];
  let current: Part = { body: "", blocks: 0 };

  const fits = (html: string): boolean =>
    current.body.length + html.length <= charBudget &&
    current.blocks + countRichBlocks(html) <= blockBudget;
  const append = (html: string): void => {
    current = { body: current.body + html, blocks: current.blocks + countRichBlocks(html) };
  };
  const flush = (): void => {
    if (current.body !== "") {
      parts.push(current);
      current = { body: "", blocks: 0 };
    }
  };

  for (const section of sections) {
    const counts = section.counts === "" ? "" : ` · ${escapeHtml(section.counts)}`;
    const sectionOpen = (continued: boolean): string =>
      `<details${open}><summary>${repoLink(section.repoName)}${counts}${continued ? " (continued)" : ""}</summary>${section.list ? "<ul>" : ""}`;
    const sectionClose = `${section.list ? "</ul>" : ""}</details>`;
    const whole = `${sectionOpen(false)}${section.items.join("")}${sectionClose}`;

    if (!fits(whole)) {
      flush();
    }

    if (fits(whole)) {
      append(whole);
      continue;
    }

    // Last resort: the section alone outgrows a message, so cut it between items.
    let chunk = sectionOpen(false);
    let chunkItems = 0;

    for (const item of section.items) {
      if (!fits(`${chunk}${item}${sectionClose}`)) {
        if (chunkItems === 0) {
          throw tooSmall();
        }
        append(`${chunk}${sectionClose}`);
        flush();
        chunk = sectionOpen(true);
        chunkItems = 0;
      }

      if (!fits(`${chunk}${item}${sectionClose}`)) {
        throw tooSmall();
      }

      chunk += item;
      chunkItems += 1;
    }

    append(`${chunk}${sectionClose}`);
  }

  flush();

  return parts.map((part) => `${header}${part.body}`);
};

export const renderRichEventDigest = (
  events: StoredEvent[],
  options: RichDigestOptions
): string[] => {
  if (events.length === 0) {
    return [];
  }

  const pullRequestDetails = options.pullRequestDetails ?? new Map();
  const sections = [...groupByRepo(events)].map(([repoName, repoEvents]) => ({
    repoName,
    counts: formatCounts(repoEvents),
    list: true,
    items: repoEvents.map((event) =>
      renderEventItem(event, pullRequestDetails.get(event.id) ?? null)
    )
  }));

  return packSections(sections, options);
};

// The model returns plain text; it is escaped here, so prompts stay unchanged.
export const renderRichAiDigest = (
  summaries: Map<string, string>,
  events: StoredEvent[],
  options: RichDigestOptions
): string[] => {
  if (summaries.size === 0) {
    return [];
  }

  const eventsByRepo = groupByRepo(events);
  const sections = [...summaries].map(([repoName, text]) => ({
    repoName,
    counts: formatCounts(eventsByRepo.get(repoName) ?? []),
    list: false,
    items: paragraphs(text)
  }));

  return packSections(sections, options);
};
