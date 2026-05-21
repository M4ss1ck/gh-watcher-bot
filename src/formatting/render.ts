// Renders event digests as Telegram HTML messages.
import type { GitHubUserSummary, StoredEvent } from "~/github/types";
import { summarizeEvent } from "~/formatting/summarize";
import type { SchedulePreset, SubscriptionPreset } from "~/db/schema";

export type RenderOptions = {
  maxMessageLength?: number;
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
    `<b>Watching @${escapeHtml(summary.login)}</b> · <a href="${escapeAttribute(summary.htmlUrl)}">profile</a>`,
    `${escapeHtml(displayName)} · ${summary.publicRepos} ${repoLabel} · ${formatCompactCount(summary.followers)} followers`,
    `Schedule: ${escapeHtml(subscription.schedulePreset)} (${escapeHtml(subscription.timezone)}) · Preset: ${escapeHtml(subscription.preset)}`,
    "Tap /subscribe to manage."
  ].join("\n");
};

const renderEvent = (event: StoredEvent): string => {
  const summary = summarizeEvent(event);
  const lines = [
    `• <b>${escapeHtml(event.repoName)}</b> · ${escapeHtml(event.actorLogin)} ${escapeHtml(summary.title)}`
  ];

  if (summary.detail !== null) {
    lines.push(`  ${escapeHtml(summary.detail)}`);
  }

  if (summary.url !== null) {
    lines.push(`  <a href="${escapeAttribute(summary.url)}">Open on GitHub</a>`);
  }

  return lines.join("\n");
};

export const renderEventDigest = (
  events: StoredEvent[],
  options: RenderOptions = {}
): string[] => {
  if (events.length === 0) {
    return [];
  }

  const maxMessageLength = options.maxMessageLength ?? defaultMaxMessageLength;
  const header = "<b>GitHub activity digest</b>";
  const messages: string[] = [];
  let current = header;

  for (const event of events) {
    const block = renderEvent(event);
    const next = `${current}\n\n${block}`;

    if (next.length > maxMessageLength && current !== header) {
      messages.push(current);
      current = `${header}\n\n${block}`;
    } else {
      current = next;
    }
  }

  messages.push(current);

  return messages;
};
