// Verifies timezone-aware user-facing date formatting.
import { describe, expect, test } from "bun:test";

import { formatDateTimeInTimeZone } from "~/formatting/dates";

describe("formatDateTimeInTimeZone", () => {
  test("formats dates in the selected timezone", () => {
    expect(
      formatDateTimeInTimeZone(
        new Date("2026-05-20T12:30:00Z"),
        "America/Santiago"
      )
    ).toBe("2026-05-20 08:30 America/Santiago");
  });

  test("falls back to UTC when the timezone is invalid", () => {
    expect(
      formatDateTimeInTimeZone(new Date("2026-05-20T12:30:00Z"), "Nope/Nowhere")
    ).toBe("2026-05-20 12:30 UTC");
  });
});
