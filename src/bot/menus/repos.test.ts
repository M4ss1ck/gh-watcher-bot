// Verifies repo picker labels.
import { describe, expect, test } from "bun:test";

import { formatRepoSelectionLabel } from "~/bot/menus/repos";

describe("formatRepoSelectionLabel", () => {
  test("formats all-repos and selected-repo states", () => {
    expect(formatRepoSelectionLabel(null)).toBe("📁 Repos: all");
    expect(formatRepoSelectionLabel(["linux"])).toBe("📁 Repos: 1 selected");
    expect(formatRepoSelectionLabel(["linux", "git"])).toBe("📁 Repos: 2 selected");
  });
});
