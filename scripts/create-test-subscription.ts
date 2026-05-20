// Creates a local subscription row for delivery verification.
import { createGitHubClient } from "~/github/client";
import { pollGitHubAccount } from "~/github/poller";
import {
  createOrUpdateSubscription,
  getGitHubAccountByLogin,
  upsertChat,
  upsertGitHubAccount
} from "~/db/queries";
import {
  chatTypeValues,
  schedulePresetValues,
  subscriptionPresetValues,
  type ChatType,
  type SchedulePreset,
  type SubscriptionPreset
} from "~/db/schema";
import { clonePresetFilters } from "~/filters/presets";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

const args = new Map(
  Bun.argv.slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value] = arg.slice(2).split("=", 2);
      return [key, value ?? "true"] as const;
    })
);

const getRequiredArg = (name: string): string => {
  const value = args.get(name);

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing --${name}`);
  }

  return value;
};

const getNumberArg = (name: string): number => {
  const value = Number(getRequiredArg(name));

  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${name} must be a safe integer`);
  }

  return value;
};

const parseEnum = <Value extends string>(
  name: string,
  value: string,
  allowed: readonly Value[]
): Value => {
  if (!allowed.includes(value as Value)) {
    throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
  }

  return value as Value;
};

const normalizeLogin = (value: string): string => value.trim().replace(/^@/, "");

const chatId = getNumberArg("chat-id");
const createdByUserId =
  args.has("created-by") ? getNumberArg("created-by") : env.ADMIN_IDS[0];
const login = normalizeLogin(getRequiredArg("github-login"));
const chatType = parseEnum<ChatType>(
  "chat-type",
  args.get("chat-type") ?? "private",
  chatTypeValues
);
const testPresetValues = subscriptionPresetValues.filter(
  (value) => value !== "custom"
) as Exclude<SubscriptionPreset, "custom">[];

const preset = parseEnum<Exclude<SubscriptionPreset, "custom">>(
  "preset",
  args.get("preset") ?? "firehose",
  testPresetValues
);
const schedulePreset = parseEnum<SchedulePreset>(
  "schedule",
  args.get("schedule") ?? "hourly",
  schedulePresetValues
);
const timezone = args.get("timezone") ?? "UTC";

await upsertChat({
  id: chatId,
  type: chatType,
  title: args.get("chat-title") ?? "Delivery test chat",
  addedByUserId: createdByUserId
});

let account = await getGitHubAccountByLogin(login);

if (account === null) {
  const client = createGitHubClient();
  const user = await client.getUser(login);
  await upsertGitHubAccount(user);
  account = await getGitHubAccountByLogin(user.login);
}

if (account === null) {
  throw new Error("GitHub account row was not created");
}

if (args.get("poll") === "true") {
  await pollGitHubAccount(account, {
    client: createGitHubClient()
  });
}

const subscriptionId = await createOrUpdateSubscription({
  chatId,
  accountId: account.id,
  preset,
  filters: clonePresetFilters(preset),
  schedulePreset,
  timezone,
  createdByUserId,
  lastDeliveredAt: null
});

logger.info(
  {
    subscription_id: subscriptionId,
    chat_id: chatId,
    account_login: account.login,
    schedule_preset: schedulePreset,
    timezone
  },
  "test subscription ready"
);
