// Verifies user-facing labels for stored enum values.
import { describe, expect, test } from "bun:test";

import {
  formatSchedulePresetLabel,
  formatSubscriptionPresetLabel
} from "~/formatting/labels";

describe("format labels", () => {
  test("humanizes schedule presets", () => {
    expect(formatSchedulePresetLabel("as_fetched")).toBe("As fetched");
    expect(formatSchedulePresetLabel("every_6h")).toBe("Every 6 hours");
    expect(formatSchedulePresetLabel("weekly_mon_09")).toBe("Weekly Monday 09:00");
  });

  test("humanizes subscription presets", () => {
    expect(formatSubscriptionPresetLabel("prs_and_releases")).toBe(
      "Pull requests and releases"
    );
    expect(formatSubscriptionPresetLabel("releases_only")).toBe("Releases only");
  });
});
