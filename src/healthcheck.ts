// Checks whether the collector heartbeat is recent enough for Docker health checks.
import { libsqlClient } from "~/db/client";
import { getKvValue } from "~/db/queries";

const parsePollIntervalMinutes = (cron: string): number => {
  const match = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(cron);

  if (match?.[1]) {
    return Number(match[1]);
  }

  return 10;
};

const main = async (): Promise<void> => {
  let exitCode = 0;

  try {
    const value = await getKvValue("collector.last_tick");

    if (!value) {
      process.stderr.write("no collector heartbeat found\n");
      exitCode = 1;
    } else {
      const lastTick = Number(value);

      if (Number.isNaN(lastTick)) {
        process.stderr.write("invalid collector heartbeat value\n");
        exitCode = 1;
      } else {
        const now = Date.now();
        const intervalMinutes = parsePollIntervalMinutes(
          process.env.POLL_INTERVAL_CRON ?? "*/10 * * * *"
        );
        const thresholdMs = intervalMinutes * 2 * 60 * 1000;

        if (now - lastTick > thresholdMs) {
          process.stderr.write(
            `collector heartbeat too old: ${Math.round((now - lastTick) / 1000)}s ago\n`
          );
          exitCode = 1;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`healthcheck error: ${message}\n`);
    exitCode = 1;
  } finally {
    await libsqlClient.close();
  }

  process.exit(exitCode);
};

await main();
