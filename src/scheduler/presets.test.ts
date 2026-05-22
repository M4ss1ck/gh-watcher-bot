// Verifies delivery schedule preset behavior.
import { describe, expect, test } from "bun:test";

import {
  getScheduleCronExpression,
  getVisibleSchedulePresetValues
} from "~/scheduler/presets";

describe("schedule presets", () => {
  test("maps as-fetched delivery to the collector cadence", () => {
    expect(getScheduleCronExpression("as_fetched", "*/7 * * * *")).toBe(
      "*/7 * * * *"
    );
  });

  test("shows as-fetched only to bot admins", () => {
    expect(getVisibleSchedulePresetValues(false)).not.toContain("as_fetched");
    expect(getVisibleSchedulePresetValues(true)).toContain("as_fetched");
  });
});
