// Renders event digests as Telegram HTML messages.
import type {
  GitHubPullRequestDetail,
  GitHubUserSummary,
  StoredEvent
} from "~/github/types";
import { summarizeEvent } from "~/formatting/summarize";
import type { SchedulePreset, SubscriptionPreset } from "~/db/schema";
import {
  formatSchedulePresetLabel,
  formatSubscriptionPresetLabel
} from "~/formatting/labels";

export type RenderOptions = {
  maxMessageLength?: number;
  pullRequestDetails?: Map<string, GitHubPullRequestDetail>;
};

export type AccountSummarySubscription = {
  schedulePreset: SchedulePreset;
  timezone: string;
  preset: SubscriptionPreset;
};

const defaultMaxMessageLength = 3900;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const escapeAttribute = (value: string): string =>
  escapeHtml(value).replaceAll("\"", "&quot;");

const formatCompactCount = (value: number): string => {
  if (value < 1_000) {
    return String(value);
  }

  return `${Math.round(value / 1_000)}k`;
};

export const renderAccountSummary = (
  summary: GitHubUserSummary,
  subscription: AccountSummarySubscription
): string => {
  const displayName = summary.name ?? summary.login;
  const repoLabel = summary.publicRepos === 1 ? "public repo" : "public repos";

  return [
    `<b>Watching <code>@${escapeHtml(summary.login)}</code></b> · <a href="${escapeAttribute(summary.htmlUrl)}">profile</a>`,
    `${escapeHtml(displayName)} · ${summary.publicRepos} ${repoLabel} · ${formatCompactCount(summary.followers)} followers`,
    `Schedule: ${escapeHtml(formatSchedulePresetLabel(subscription.schedulePreset))} (${escapeHtml(subscription.timezone)}) · Preset: ${escapeHtml(formatSubscriptionPresetLabel(subscription.preset))}`,
    "Tap /subscribe to manage."
  ].join("\n");
};

const githubProfileUrl = (login: string): string =>
  `https://github.com/${encodeURIComponent(login)}`;

const githubRepoUrl = (repoName: string): string =>
  `https://github.com/${repoName}`;

const formatRepoHeader = (repoName: string): string =>
  `<b><a href="${escapeAttribute(githubRepoUrl(repoName))}">${escapeHtml(repoName)}</a></b>`;

const formatActorLink = (login: string): string =>
  `<a href="${escapeAttribute(githubProfileUrl(login))}">${escapeHtml(login)}</a>`;

const renderEventLine = (
  event: StoredEvent,
  pullRequestDetail: GitHubPullRequestDetail | null
): string => {
  const summary = summarizeEvent(event, { pullRequestDetail });
  const lines = [
    `• ${formatActorLink(event.actorLogin)} ${escapeHtml(summary.title)}`
  ];

  if (summary.detail !== null) {
    lines.push(`  ${escapeHtml(summary.detail)}`);
  }

  for (const extra of summary.extra) {
    lines.push(`  ${escapeHtml(extra)}`);
  }

  return lines.join("\n");
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

export const renderEventDigest = (
  events: StoredEvent[],
  options: RenderOptions = {}
): string[] => {
  if (events.length === 0) {
    return [];
  }

  const pullRequestDetails = options.pullRequestDetails ?? new Map();
  return renderRepoSections(
    [...groupByRepo(events)].map(([repoName, repoEvents]) => ({
      repoName,
      lines: repoEvents.map((event) =>
        renderEventLine(event, pullRequestDetails.get(event.id) ?? null)
      )
    })),
    "<b>GitHub activity digest</b>",
    options.maxMessageLength ?? defaultMaxMessageLength
  );
};

type RepoSection = { repoName: string; lines: string[] };

const quoteOpen = "<blockquote expandable>";
const quoteClose = "</blockquote>";
const closeTag = (tag: string): string => `</${tag.slice(1).split(/[ >]/u, 1)[0]}>`;

// Splitting a long fragment closes and reopens inline tags so every part parses on its own.
const splitHtmlFragment = (html: string, maxLength: number): string[] => {
  const tokens = html.match(/<[^>]+>|&(?:amp|lt|gt|quot);|&#(?:\d+|x[\da-fA-F]+);|[\s\S]/gu) ?? [];
  const pieces: string[] = [];
  const openTags: string[] = [];
  let current = "";
  let hasText = false;

  for (const token of tokens) {
    const isClose = token.startsWith("</");
    const isOpen = token.startsWith("<") && !isClose;
    const nextTags = isClose ? openTags.slice(0, -1) : isOpen ? [...openTags, token] : openTags;
    const closingLength = nextTags.reduce((sum, tag) => sum + closeTag(tag).length, 0);

    if (current.length + token.length + closingLength > maxLength) {
      if (!hasText) {
        throw new RangeError("Message limit is too small for a repository section");
      }
      pieces.push(current + openTags.map(closeTag).reverse().join(""));
      current = openTags.join("");
      hasText = false;
    }

    current += token;
    if (isClose) {
      openTags.pop();
    } else if (isOpen) {
      openTags.push(token);
    } else {
      hasText = true;
    }
  }

  if (current.length > 0) {
    pieces.push(current);
  }

  return pieces;
};

const renderRepoSections = (
  sections: RepoSection[],
  header: string,
  maxMessageLength: number
): string[] => {
  const messages: string[] = [];
  let current = header;
  let currentRepo: string | null = null;
  let hasContent = false;

  const flush = (): void => {
    if (!hasContent) {
      return;
    }
    messages.push(current + quoteClose);
    current = header;
    currentRepo = null;
    hasContent = false;
  };

  for (const { repoName, lines } of sections) {
    const repoStart = `\n\n${formatRepoHeader(repoName)}\n${quoteOpen}`;
    const maxFragmentLength = maxMessageLength - header.length - repoStart.length - quoteClose.length;

    for (const line of lines) {
      for (const fragment of splitHtmlFragment(line, maxFragmentLength)) {
        const sameRepo = currentRepo === repoName;
        const addition = sameRepo ? `\n${fragment}` : `${currentRepo === null ? "" : quoteClose}${repoStart}${fragment}`;

        if (current.length + addition.length + quoteClose.length > maxMessageLength) {
          flush();
          current += `${repoStart}${fragment}`;
        } else {
          current += addition;
        }

        currentRepo = repoName;
        hasContent = true;
      }
    }
  }

  flush();
  return messages;
};

export const renderAiDigest = (
  summaries: Map<string, string>,
  options: RenderOptions = {}
): string[] => {
  return renderRepoSections(
    [...summaries].map(([repoName, summaryText]) => ({
      repoName,
      lines: escapeHtml(summaryText).split("\n")
    })),
    "<b>GitHub activity digest</b> · AI summary",
    options.maxMessageLength ?? defaultMaxMessageLength
  );
};
