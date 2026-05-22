// Verifies that /subscribe creates a real subscription before opening menus.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";

import { clonePresetFilters } from "~/filters/presets";

type CommandHandler = (ctx: Context & { match?: string }) => Promise<void>;

let commandHandler: CommandHandler | null = null;
let createdSubscription: unknown = null;
let createdRepo: unknown = null;
let delivererSyncCount = 0;
let existingSubscriptions: unknown[] = [];

const githubClient = {
  getUser: async (_login: string) => ({
    id: 583231,
    login: "octocat",
    name: "The Octocat",
    bio: null,
    publicRepos: 8,
    followers: 12_345,
    htmlUrl: "https://github.com/octocat"
  }),
  getRepo: async (_owner: string, repo: string) => ({
    id: 1296269,
    name: repo,
    fullName: `octocat/${repo}`
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
  resolveOrCreateGitHubRepo: async (input: unknown) => {
    createdRepo = input;

    return {
      id: 1296269,
      name: "hello-world",
      fullName: "octocat/hello-world"
    };
  },
  deleteSubscription: async () => undefined,
  getGitHubAccountById: async () => null,
  listSubscriptionsForChat: async () => existingSubscriptions,
  resolveOrCreateGitHubAccount: async (login: string) => {
    return githubClient.getUser(login);
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
    createdRepo = null;
    delivererSyncCount = 0;
    existingSubscriptions = [];
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
      selectedRepos: null,
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
      selectedRepos: null,
      paused: false,
      lastDeliveredAt: null
    });
    expect(replies).toContain(
      [
        "<b>Watching <code>@octocat</code></b> · <a href=\"https://github.com/octocat\">profile</a>",
        "The Octocat · 8 public repos · 12k followers",
        "Schedule: Hourly (UTC) · Preset: Firehose",
        "Tap /subscribe to manage."
      ].join("\n")
    );
    expect(replies).toContain(
      [
        "<code>@octocat</code>",
        "Preset: Firehose",
        "Schedule: Hourly",
        "Timezone: UTC",
        "Repos: all repos",
        "Status: active",
        "Last delivery: never"
      ].join("\n")
    );
    expect(delivererSyncCount).toBe(1);
  });

  test("creates an owner subscription narrowed to a repo target", async () => {
    const { registerSubscribeCommand } = await import("~/bot/commands/subscribe");

    registerSubscribeCommand(createBot());

    await commandHandler?.({
      match: "octocat/hello-world",
      chat: { id: 123, type: "private" },
      from: { id: 456, is_bot: false, first_name: "Ada" },
      reply: async () => ({} as never)
    } as unknown as Context & { match?: string });

    expect(createdRepo).toEqual({
      accountId: 583231,
      owner: "octocat",
      repo: "hello-world",
      client: githubClient
    });
    expect(createdSubscription).toEqual({
      chatId: 123,
      accountId: 583231,
      preset: "firehose",
      filters: clonePresetFilters("firehose"),
      schedulePreset: "hourly",
      timezone: "UTC",
      selectedRepos: ["hello-world"],
      createdByUserId: 456,
      lastDeliveredAt: null
    });
  });

  test("creates a channel subscription when the command comes from a channel post", async () => {
    const { getSelectedSubscription } = await import("~/bot/menus/state");
    const { registerSubscribeCommand } = await import("~/bot/commands/subscribe");
    const replies: string[] = [];

    registerSubscribeCommand(createBot());

    await commandHandler?.({
      match: "@octocat",
      chat: { id: -100123, type: "channel", title: "Release feed" },
      channelPost: {
        message_id: 10,
        date: 1,
        chat: { id: -100123, type: "channel", title: "Release feed" },
        text: "/subscribe @octocat"
      },
      reply: async (text: string) => {
        replies.push(text);

        return {} as never;
      }
    } as unknown as Context & { match?: string });

    expect(createdSubscription).toEqual({
      chatId: -100123,
      accountId: 583231,
      preset: "firehose",
      filters: clonePresetFilters("firehose"),
      schedulePreset: "hourly",
      timezone: "UTC",
      selectedRepos: null,
      createdByUserId: 0,
      lastDeliveredAt: null
    });
    expect(getSelectedSubscription({ chatId: -100123, userId: 0 })).toBeNull();
    expect(replies).toContain("Subscriptions in this chat");
  });

  test("keeps an existing all-repos owner subscription broad for repo targets", async () => {
    const { registerSubscribeCommand } = await import("~/bot/commands/subscribe");
    existingSubscriptions = [
      {
        id: 91,
        accountId: 583231,
        accountLogin: "octocat",
        preset: "firehose",
        schedulePreset: "hourly",
        timezone: "UTC",
        selectedRepos: null,
        paused: false,
        lastDeliveredAt: null
      }
    ];

    registerSubscribeCommand(createBot());

    await commandHandler?.({
      match: "octocat/hello-world",
      chat: { id: 123, type: "private" },
      from: { id: 456, is_bot: false, first_name: "Ada" },
      reply: async () => ({} as never)
    } as unknown as Context & { match?: string });

    expect(createdSubscription).toEqual({
      chatId: 123,
      accountId: 583231,
      preset: "firehose",
      filters: clonePresetFilters("firehose"),
      schedulePreset: "hourly",
      timezone: "UTC",
      selectedRepos: null,
      createdByUserId: 456,
      lastDeliveredAt: null
    });
  });

  test("keeps an existing repo-narrowed owner subscription narrow for owner targets", async () => {
    const { registerSubscribeCommand } = await import("~/bot/commands/subscribe");
    existingSubscriptions = [
      {
        id: 91,
        accountId: 583231,
        accountLogin: "octocat",
        preset: "firehose",
        schedulePreset: "hourly",
        timezone: "UTC",
        selectedRepos: ["hello-world"],
        paused: false,
        lastDeliveredAt: null
      }
    ];

    registerSubscribeCommand(createBot());

    await commandHandler?.({
      match: "@octocat",
      chat: { id: 123, type: "private" },
      from: { id: 456, is_bot: false, first_name: "Ada" },
      reply: async () => ({} as never)
    } as unknown as Context & { match?: string });

    expect(createdSubscription).toEqual({
      chatId: 123,
      accountId: 583231,
      preset: "firehose",
      filters: clonePresetFilters("firehose"),
      schedulePreset: "hourly",
      timezone: "UTC",
      selectedRepos: ["hello-world"],
      createdByUserId: 456,
      lastDeliveredAt: null
    });
  });
});
