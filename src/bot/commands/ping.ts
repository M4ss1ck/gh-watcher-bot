// Handles the ping command and admin diagnostics summary.
import type { Bot } from "grammy";

import { isAdminUserId, type AdminDiagnosticsInput } from "~/bot/commands/admin";
import { getGitHubRateLimitRemaining } from "~/github/client";

export const collectorHeartbeatKey = "collector.last_tick";

export type CollectorTickReader = () => Promise<number | null>;

export const formatCollectorTickAge = (
  lastTickMs: number | null,
  nowMs = Date.now()
): string => {
  if (lastTickMs === null) {
    return "unavailable";
  }

  const ageSeconds = Math.max(0, Math.floor((nowMs - lastTickMs) / 1000));

  return `${ageSeconds}s ago`;
};

export const buildPingMessage = (
  lastTickMs: number | null,
  nowMs = Date.now(),
  adminDiagnostics?: Omit<AdminDiagnosticsInput, "lastCollectorTickAge">
): string => {
  const lastCollectorTickAge = formatCollectorTickAge(lastTickMs, nowMs);
  const publicMessage = `alive, last collector tick ${lastCollectorTickAge}`;

  if (adminDiagnostics === undefined) {
    return publicMessage;
  }

  return [
    publicMessage,
    `admin: active subs ${adminDiagnostics.activeSubscriptions}, active chats ${adminDiagnostics.activeChats}, events 24h ${adminDiagnostics.eventsIngestedLast24h}, errors 24h ${adminDiagnostics.errorsLast24h}, github rate remaining ${adminDiagnostics.githubRateLimitRemaining}`
  ].join("\n");
};

export const readCollectorLastTickMs: CollectorTickReader = async () => {
  const { getKvValue } = await import("~/db/queries");
  const value = await getKvValue(collectorHeartbeatKey);

  if (value === null) {
    return null;
  }

  const timestamp = Number(value);

  return Number.isFinite(timestamp) ? timestamp : null;
};

export const registerPingCommand = (
  bot: Bot,
  readLastTickMs: CollectorTickReader = readCollectorLastTickMs
): void => {
  bot.command("ping", async (ctx) => {
    const lastTickMs = await readLastTickMs();

    if (!isAdminUserId(ctx.from?.id)) {
      await ctx.reply(buildPingMessage(lastTickMs));
      return;
    }

    const [{ getAdminDiagnosticsCounts }, { getMetricsSnapshot }] =
      await Promise.all([import("~/db/queries"), import("~/lib/metrics")]);
    const [counts, metrics] = await Promise.all([
      getAdminDiagnosticsCounts(),
      Promise.resolve(getMetricsSnapshot())
    ]);
    const errorsLast24h =
      metrics.githubApiRequestsTotal.error +
      metrics.deliveriesSentTotal.error +
      Object.values(metrics.telegramApiErrorsTotal).reduce(
        (sum, value) => sum + value,
        0
      );

    const remaining = getGitHubRateLimitRemaining();

    await ctx.reply(
      buildPingMessage(lastTickMs, Date.now(), {
        githubRateLimitRemaining: remaining === null ? "unknown" : String(remaining),
        activeSubscriptions: counts.activeSubscriptions,
        activeChats: counts.activeChats,
        eventsIngestedLast24h: counts.eventsIngestedLast24h,
        errorsLast24h,
        metrics
      })
    );
  });
};
