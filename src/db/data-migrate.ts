// Idempotent data migrations for subscription filter shape changes.
import { eq } from "drizzle-orm";

import { db } from "~/db/client";
import { subscriptions, type SubscriptionFilters } from "~/db/schema";
import { logger } from "~/lib/logger";

const eventExpansions: Record<string, readonly string[]> = {
  pull_request: [
    "pull_request_opened",
    "pull_request_closed",
    "pull_request_merged",
    "pull_request_reopened"
  ],
  issues: ["issue_opened", "issue_closed", "issue_reopened"],
  create: ["branch_created", "tag_created"]
};

type Migration = {
  events: string[];
  changed: boolean;
};

const migrateEvents = (events: unknown): Migration => {
  if (!Array.isArray(events)) {
    return { events: [], changed: false };
  }

  const result: string[] = [];
  let changed = false;

  for (const value of events) {
    if (typeof value !== "string") {
      continue;
    }

    const expansion = eventExpansions[value];

    if (expansion === undefined) {
      result.push(value);
      continue;
    }

    changed = true;

    for (const expanded of expansion) {
      result.push(expanded);
    }
  }

  return { events: [...new Set(result)], changed };
};

export const migrateFilters = (
  raw: unknown
): { filters: SubscriptionFilters; changed: boolean } | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const original = raw as Record<string, unknown>;
  const eventMigration = migrateEvents(original.events);
  const hasEnrichField =
    "enrichMergedPullRequests" in original &&
    typeof original.enrichMergedPullRequests === "boolean";

  if (!eventMigration.changed && hasEnrichField) {
    return { filters: original as unknown as SubscriptionFilters, changed: false };
  }

  const filters = {
    ...original,
    events: eventMigration.events,
    enrichMergedPullRequests: hasEnrichField
      ? original.enrichMergedPullRequests
      : false
  } as SubscriptionFilters;

  return { filters, changed: true };
};

export const migrateSubscriptionFilters = async (): Promise<void> => {
  const rows = await db
    .select({ id: subscriptions.id, filters: subscriptions.filters })
    .from(subscriptions);

  let updated = 0;

  for (const row of rows) {
    const result = migrateFilters(row.filters);

    if (result === null || !result.changed) {
      continue;
    }

    await db
      .update(subscriptions)
      .set({ filters: result.filters })
      .where(eq(subscriptions.id, row.id));

    updated += 1;
  }

  if (updated > 0) {
    logger.info({ subscriptions_updated: updated }, "filter shape migration applied");
  }
};
