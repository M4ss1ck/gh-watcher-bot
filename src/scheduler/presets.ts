// Maps schedule presets to cron expressions.
import { schedulePresetValues, type SchedulePreset } from "~/db/schema";

const defaultPollIntervalCron = "*/10 * * * *";

export const schedulePresetCronExpressions: Record<
  Exclude<SchedulePreset, "as_fetched">,
  string
> = {
  hourly: "0 * * * *",
  every_6h: "0 */6 * * *",
  daily_09: "0 9 * * *",
  daily_18: "0 18 * * *",
  weekly_mon_09: "0 9 * * 1"
};

export const getScheduleCronExpression = (
  preset: SchedulePreset,
  pollIntervalCron = defaultPollIntervalCron
): string =>
  preset === "as_fetched" ? pollIntervalCron : schedulePresetCronExpressions[preset];

export const getVisibleSchedulePresetValues = (
  isBotAdmin: boolean
): SchedulePreset[] =>
  isBotAdmin
    ? [...schedulePresetValues]
    : schedulePresetValues.filter((preset) => preset !== "as_fetched");
