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

  const maxMessageLength = options.maxMessageLength ?? defaultMaxMessageLength;
  const pullRequestDetails = options.pullRequestDetails ?? new Map();
  const header = "<b>GitHub activity digest</b>";
  const messages: string[] = [];
  let current = header;
  let currentRepo: string | null = null;

  for (const [repoName, repoEvents] of groupByRepo(events)) {
    const repoHeader = formatRepoHeader(repoName);

    for (const event of repoEvents) {
      const eventLine = renderEventLine(
        event,
        pullRequestDetails.get(event.id) ?? null
      );
      const candidate =
        currentRepo === repoName
          ? `${current}\n${eventLine}`
          : `${current}\n\n${repoHeader}\n${eventLine}`;

      if (candidate.length > maxMessageLength && current !== header) {
        messages.push(current);
        current = `${header}\n\n${repoHeader}\n${eventLine}`;
      } else {
        current = candidate;
      }

      currentRepo = repoName;
    }
  }

  messages.push(current);

  return messages;
};
