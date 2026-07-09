// Verifies cursor-based delivery behavior without live Telegram calls.
import { describe, expect, test } from "bun:test";

import type { StoredEvent } from "~/github/types";
import {
  fixtureEvents,
  pushEvent,
  releaseEvent
} from "~/test/fixtures/github-events";
import {
  runDeliveryTask,
  type DeliverySendMessage,
  type DeliveryStore,
  type SubscriptionForDelivery
} from "~/scheduler/deliverer";
import { filterPresets } from "~/filters/presets";

const subscription: SubscriptionForDelivery = {
  id: 11,
  chatId: 42,
  chatActive: true,
  chatBanned: false,
  accountId: 1,
  accountLogin: "octocat",
  filters: filterPresets.firehose,
  selectedRepos: null,
  lastDeliveredAt: null,
  aiSummary: false
};

const createStore = (events: StoredEvent[]) => {
  const cursorWrites: Date[] = [];
  const heartbeatWrites: Date[] = [];
  const store: DeliveryStore = {
    getSubscriptionForDelivery: async () => subscription,
    listEventsForDelivery: async () => events,
    updateSubscriptionDeliveryCursor: async (_subscriptionId, deliveredAt) => {
      cursorWrites.push(deliveredAt);
    },
    writeDelivererHeartbeat: async (date) => {
      if (date === undefined) {
        throw new Error("expected heartbeat date");
      }
      heartbeatWrites.push(date);
    }
  };

  return { cursorWrites, heartbeatWrites, store };
};

const aiSubscription: SubscriptionForDelivery = {
  ...subscription,
  aiSummary: true
};

const storeWithSubscription = (
  events: StoredEvent[],
  record: SubscriptionForDelivery
) => {
  const base = createStore(events);

  return {
    ...base,
    store: {
      ...base.store,
      getSubscriptionForDelivery: async () => record
    }
  };
};

describe("runDeliveryTask", () => {
  test("sends matching events and advances the cursor to the newest event", async () => {
    const { cursorWrites, heartbeatWrites, store } = createStore([
      pushEvent,
      releaseEvent
    ]);
    const sentMessages: string[] = [];
    const sendMessage: DeliverySendMessage = async (_chatId, text) => {
      sentMessages.push(text);
    };

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      sendMessage,
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.status).toBe("ok");
    expect(result.eventCount).toBe(2);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("GitHub activity digest");
    expect(cursorWrites.map((date) => date.toISOString())).toEqual([
      "2026-05-20T12:10:00.000Z"
    ]);
    expect(heartbeatWrites.map((date) => date.toISOString())).toEqual([
      "2026-05-20T13:00:00.000Z"
    ]);
  });

  test("does not send when filters remove every event and advances to newest seen", async () => {
    const storeState = createStore([releaseEvent]);
    const codeOnlySubscription = {
      ...subscription,
      filters: filterPresets.code_activity
    };
    const store: DeliveryStore = {
      ...storeState.store,
      getSubscriptionForDelivery: async () => codeOnlySubscription
    };
    const sentMessages: string[] = [];

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      now: new Date("2026-05-20T13:05:00Z")
    });

    expect(result.status).toBe("empty");
    expect(result.eventCount).toBe(0);
    expect(sentMessages.length).toBe(0);
    expect(storeState.cursorWrites.map((date) => date.toISOString())).toEqual([
      releaseEvent.createdAt.toISOString()
    ]);
  });

  test("leaves the cursor unchanged when there are no events to deliver", async () => {
    const { cursorWrites, store } = createStore([]);

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      sendMessage: async () => {
        throw new Error("should not send");
      },
      now: new Date("2026-05-20T13:05:00Z")
    });

    expect(result.status).toBe("empty");
    expect(cursorWrites).toEqual([]);
  });

  test("leaves the cursor unchanged when Telegram sending fails", async () => {
    const { cursorWrites, heartbeatWrites, store } = createStore([pushEvent]);

    await expect(
      runDeliveryTask({
        subscriptionId: subscription.id,
        store,
        sendMessage: async () => {
          throw new Error("telegram unavailable");
        },
        now: new Date("2026-05-20T13:10:00Z")
      })
    ).rejects.toThrow("telegram unavailable");

    expect(cursorWrites).toEqual([]);
    expect(heartbeatWrites.map((date) => date.toISOString())).toEqual([
      "2026-05-20T13:10:00.000Z"
    ]);
  });

  test("skips inactive chats without advancing the cursor", async () => {
    const { cursorWrites, store } = createStore([pushEvent]);
    const inactiveStore: DeliveryStore = {
      ...store,
      getSubscriptionForDelivery: async () => ({
        ...subscription,
        chatActive: false
      })
    };

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store: inactiveStore,
      sendMessage: async () => {
        throw new Error("should not send");
      }
    });

    expect(result.status).toBe("skipped");
    expect(cursorWrites).toEqual([]);
  });

  test("narrows delivery to selected repos before rendering", async () => {
    const storeState = createStore([
      pushEvent,
      {
        ...releaseEvent,
        repoName: "octocat/other-repo",
        createdAt: new Date("2026-05-20T12:30:00Z")
      }
    ]);
    const linuxOnlyStore: DeliveryStore = {
      ...storeState.store,
      getSubscriptionForDelivery: async () => ({
        ...subscription,
        selectedRepos: ["hello-world"]
      })
    };
    const sentMessages: string[] = [];

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store: linuxOnlyStore,
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      now: new Date("2026-05-20T13:20:00Z")
    });

    expect(result.status).toBe("ok");
    expect(result.eventCount).toBe(1);
    expect(sentMessages[0]).toContain("octocat/hello-world");
    expect(sentMessages[0]).not.toContain("octocat/other-repo");
    expect(storeState.cursorWrites.map((date) => date.toISOString())).toEqual([
      "2026-05-20T12:00:00.000Z"
    ]);
  });

  test("skips delivery once shutdown begins", async () => {
    const { cursorWrites, store } = createStore([pushEvent]);

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      sendMessage: async () => {
        throw new Error("should not send during shutdown");
      },
      isShuttingDown: () => true,
      now: new Date("2026-05-20T13:05:00Z")
    });

    expect(result.status).toBe("skipped");
    expect(cursorWrites.length).toBe(0);
  });
});

describe("runDeliveryTask with ai summaries", () => {
  test("sends a single AI digest when the summarizer succeeds", async () => {
    const { store } = storeWithSubscription([pushEvent, releaseEvent], aiSubscription);
    const sentMessages: string[] = [];

    const result = await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      aiSummarizer: {
        isAvailable: () => true,
        generate: async () => "Two things happened today."
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.status).toBe("ok");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("AI summary");
    expect(sentMessages[0]).toContain("Two things happened today.");
  });

  test("falls back to the mechanical digest when the summarizer fails", async () => {
    const { cursorWrites, store } = storeWithSubscription([pushEvent], aiSubscription);
    const sentMessages: string[] = [];

    const result = await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      aiSummarizer: {
        isAvailable: () => true,
        generate: async () => null
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.status).toBe("ok");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).not.toContain("AI summary");
    expect(sentMessages[0]).toContain("GitHub activity digest");
    expect(cursorWrites.length).toBe(1);
  });

  test("does not call the summarizer when the subscription has it off", async () => {
    const { store } = storeWithSubscription([pushEvent], subscription);
    let generateCalls = 0;

    await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      sendMessage: async () => {},
      aiSummarizer: {
        isAvailable: () => true,
        generate: async () => {
          generateCalls += 1;
          return "should not be used";
        }
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(generateCalls).toBe(0);
  });
});
