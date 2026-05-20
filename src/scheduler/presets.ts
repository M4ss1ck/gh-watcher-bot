// Maps schedule presets to cron expressions.
import type { SchedulePreset } from "~/db/schema";

export const schedulePresetCronExpressions: Record<SchedulePreset, string> = {
  hourly: "0 * * * *",
  every_6h: "0 */6 * * *",
  daily_09: "0 9 * * *",
  daily_18: "0 18 * * *",
  weekly_mon_09: "0 9 * * 1"
};

export const getScheduleCronExpression = (preset: SchedulePreset): string =>
  schedulePresetCronExpressions[preset];
