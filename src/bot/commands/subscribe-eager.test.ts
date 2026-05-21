// Verifies that /subscribe creates a real subscription before opening menus.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";

import { clonePresetFilters } from "~/filters/presets";

type CommandHandler = (ctx: Context & { match?: string }) => Promise<void>;

let commandHandler: CommandHandler | null = null;
let createdSubscription: unknown = null;
let delivererSyncCount = 0;

const githubClient = {
  getUser: async (_login: string) => ({
    id: 583231,
    login: "octocat"
  })
};

mock.module("~/bot/menus/deps", () => ({
  getDeliverer: () => ({
    sync: async () => {
      delivererSyncCount += 1;
    }
  }),
  getGitHubClient: () => githubClient,
  setDeliverer: () => undefined,
  setGitHubClient: () => undefined
}));

mock.module("~/db/queries", () => ({
  countSubscriptionsForChat: async () => 0,
  createOrUpdateSubscription: async (input: unknown) => {
    createdSubscription = input;

    return 91;
  },
  deleteSubscription: async () => undefined,
  listSubscriptionsForChat: async () => [],
  resolveOrCreateGitHubAccount: async (login: string) => {
    const user = await githubClient.getUser(login);

    return {
      id: user.id,
      login: user.login
    };
  },
  setKvValue: async () => undefined,
  setSubscriptionPaused: async () => undefined,
  updateSubscriptionFilters: async () => undefined,
  updateSubscriptionSchedule: async () => undefined
}));

const createBot = (): Bot => ({
  on: () => undefined,
  command: (_command: string, ...handlers: CommandHandler[]) => {
    commandHandler = handlers.at(-1) ?? null;
  }
} as unknown as Bot);

describe("/subscribe eager creation", () => {
  beforeEach(() => {
    commandHandler = null;
    createdSubscription = null;
    delivererSyncCount = 0;
  });

  test("creates a subscription with defaults before opening the menu", async () => {
    const { getSelectedSubscription } = await import("~/bot/menus/state");
    const { registerSubscribeCommand } = await import("~/bot/commands/subscribe");
    const replies: string[] = [];

    registerSubscribeCommand(createBot());

    await commandHandler?.({
      match: "@octocat",
      chat: { id: 123, type: "private" },
      from: { id: 456, is_bot: false, first_name: "Ada" },
      reply: async (text: string) => {
        replies.push(text);

        return {} as never;
      }
    } as unknown as Context & { match?: string });

    expect(createdSubscription).toEqual({
      chatId: 123,
      accountId: 583231,
      preset: "firehose",
      filters: clonePresetFilters("firehose"),
      schedulePreset: "hourly",
      timezone: "UTC",
      createdByUserId: 456,
      lastDeliveredAt: null
    });
    expect(getSelectedSubscription({ chatId: 123, userId: 456 })).toEqual({
      id: 91,
      accountId: 583231,
      accountLogin: "octocat",
      preset: "firehose",
      schedulePreset: "hourly",
      timezone: "UTC",
      paused: false,
      lastDeliveredAt: null
    });
    expect(replies).toContain(
      [
        "@octocat",
        "Preset: firehose",
        "Schedule: hourly",
        "Timezone: UTC",
        "Status: active",
        "Last delivery: never"
      ].join("\n")
    );
    expect(delivererSyncCount).toBe(1);
  });
});
