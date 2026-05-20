// Handles the ping command and admin diagnostics summary.
import type { Bot } from "grammy";

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
  nowMs = Date.now()
): string => `alive, last collector tick ${formatCollectorTickAge(lastTickMs, nowMs)}`;

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

    await ctx.reply(buildPingMessage(lastTickMs));
  });
};
