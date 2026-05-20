// Renders event digests as Telegram HTML messages.
import type { StoredEvent } from "~/github/types";
import { summarizeEvent } from "~/formatting/summarize";

export type RenderOptions = {
  maxMessageLength?: number;
};

const defaultMaxMessageLength = 3900;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const escapeAttribute = (value: string): string =>
  escapeHtml(value).replaceAll("\"", "&quot;");

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
