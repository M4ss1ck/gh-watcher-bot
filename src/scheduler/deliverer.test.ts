// Verifies cursor-based delivery behavior without live Telegram calls.
import { describe, expect, test } from "bun:test";
import { GrammyError } from "grammy";

import type { StoredEvent } from "~/github/types";
import {
  fixtureEvents,
  pushEvent,
  releaseEvent
} from "~/test/fixtures/github-events";
import {
  createDeliveryTransport,
  runDeliveryTask,
  sendDigest,
  type DeliveryTransport,
  type DeliveryStore,
  type SubscriptionForDelivery
} from "~/scheduler/deliverer";
import { filterPresets } from "~/filters/presets";

type SendRich = DeliveryTransport["sendRich"];

// Records rich sends; any HTML fallback is a test failure unless a test opts in.
const richOnly = (sendRich: SendRich): DeliveryTransport => ({
  sendRich,
  sendHtml: async () => {
    throw new Error("unexpected HTML fallback");
  }
});

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
    const sendRich: SendRich = async (_chatId, text) => {
      sentMessages.push(text);
    };

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      transport: richOnly(sendRich),
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.status).toBe("ok");
    expect(result.eventCount).toBe(2);
    expect(result.format).toBe("rich");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("@octocat · GitHub activity");
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
      transport: richOnly(async (_chatId, text) => {
        sentMessages.push(text);
      }),
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
      transport: richOnly(async () => {
        throw new Error("should not send");
      }),
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
        transport: richOnly(async () => {
          throw new Error("telegram unavailable");
        }),
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
      transport: richOnly(async () => {
        throw new Error("should not send");
      })
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
      transport: richOnly(async (_chatId, text) => {
        sentMessages.push(text);
      }),
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
      transport: richOnly(async () => {
        throw new Error("should not send during shutdown");
      }),
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
      transport: richOnly(async (_chatId, text) => {
        sentMessages.push(text);
      }),
      aiSummarizer: {
        isAvailable: () => true,
        generate: async () => "Two things happened today."
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.status).toBe("ok");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("<p>Two things happened today.</p>");
    expect(sentMessages[0]).not.toContain("<ul>");
  });

  test("summarizes each repo from its own events and labels both sections", async () => {
    const otherEvent = { ...pushEvent, id: "other-push", repoName: "octocat/other" };
    const { store } = storeWithSubscription([pushEvent, otherEvent], aiSubscription);
    const calls: string[][] = [];
    const sentMessages: string[] = [];

    await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      transport: richOnly(async (_chatId, text) => { sentMessages.push(text); }),
      aiSummarizer: {
        isAvailable: () => true,
        generate: async (events) => {
          calls.push(events.map((event) => event.repoName));
          return `Summary for ${events[0]?.repoName}`;
        }
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(calls).toEqual([[pushEvent.repoName], [otherEvent.repoName]]);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].match(/<details>/gu)).toHaveLength(2);
    expect(sentMessages[0]).toContain("octocat/other</a> · 1 push</summary><p>Summary for octocat/other</p>");
  });

  test("uses the standard digest if any repository summary fails", async () => {
    const otherEvent = { ...pushEvent, id: "other-push", repoName: "octocat/other" };
    const { store } = storeWithSubscription([pushEvent, otherEvent], aiSubscription);
    const sentMessages: string[] = [];

    await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      transport: richOnly(async (_chatId, text) => { sentMessages.push(text); }),
      aiSummarizer: {
        isAvailable: () => true,
        generate: async (events) => events[0]?.repoName === otherEvent.repoName ? null : "First summary"
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("<ul>");
    expect(sentMessages[0].match(/<details>/gu)).toHaveLength(2);
  });

  test("uses the standard digest if a repository summary is blank", async () => {
    const { store } = storeWithSubscription([pushEvent], aiSubscription);
    const sentMessages: string[] = [];

    await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      transport: richOnly(async (_chatId, text) => { sentMessages.push(text); }),
      aiSummarizer: {
        isAvailable: () => true,
        generate: async () => "   "
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(sentMessages[0]).toContain("<ul>");
    expect(sentMessages[0]).toContain("<details open>");
  });

  test("falls back to the mechanical digest when the summarizer fails", async () => {
    const { cursorWrites, store } = storeWithSubscription([pushEvent], aiSubscription);
    const sentMessages: string[] = [];

    const result = await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      transport: richOnly(async (_chatId, text) => {
        sentMessages.push(text);
      }),
      aiSummarizer: {
        isAvailable: () => true,
        generate: async () => null
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.status).toBe("ok");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("<ul>");
    expect(sentMessages[0]).toContain("@octocat · GitHub activity");
    expect(cursorWrites.length).toBe(1);
  });

  test("falls back to the mechanical digest when the summarizer throws", async () => {
    const { cursorWrites, store } = storeWithSubscription([pushEvent], aiSubscription);
    const sentMessages: string[] = [];

    const result = await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      transport: richOnly(async (_chatId, text) => {
        sentMessages.push(text);
      }),
      aiSummarizer: {
        isAvailable: () => true,
        generate: async () => {
          throw new Error("provider exploded");
        }
      },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.status).toBe("ok");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("<ul>");
    expect(sentMessages[0]).toContain("@octocat · GitHub activity");
    expect(cursorWrites.length).toBe(1);
  });

  test("does not call the summarizer when the subscription has it off", async () => {
    const { store } = storeWithSubscription([pushEvent], subscription);
    let generateCalls = 0;

    await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      transport: richOnly(async () => {}),
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

const telegramError = (code: number): GrammyError =>
  new GrammyError(
    "Call to 'sendRichMessage' failed!",
    { ok: false, error_code: code, description: `error ${code}` },
    "sendRichMessage",
    {}
  );

// 200 pushes (4 blocks each) render well past the 500-block limit, so the digest has several parts.
const manyPushEvents = (count: number): StoredEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    ...pushEvent,
    id: `push-many-${index}`,
    createdAt: new Date(pushEvent.createdAt.getTime() + index * 1000)
  }));

type Sent = { format: "rich" | "html"; text: string };

const recordingTransport = (
  failRich: (callIndex: number) => Error | null = () => null
): { sent: Sent[]; transport: DeliveryTransport } => {
  const sent: Sent[] = [];
  let richCalls = 0;

  return {
    sent,
    transport: {
      sendRich: async (_chatId, text) => {
        const error = failRich(richCalls);
        richCalls += 1;
        if (error !== null) {
          throw error;
        }
        sent.push({ format: "rich", text });
      },
      sendHtml: async (_chatId, text) => {
        sent.push({ format: "html", text });
      }
    }
  };
};

const silentLogger = { warn: () => undefined };

describe("sendDigest", () => {
  const digest = { rich: ["r1", "r2", "r3"], html: ["h1", "h2"] };

  test("sends every rich part in order", async () => {
    const { sent, transport } = recordingTransport();

    expect(await sendDigest(transport, 42, digest, silentLogger)).toEqual({
      format: "rich",
      messageCount: 3
    });
    expect(sent).toEqual([
      { format: "rich", text: "r1" },
      { format: "rich", text: "r2" },
      { format: "rich", text: "r3" }
    ]);
  });

  test("sends the HTML version when the first rich part gets a 400", async () => {
    const { sent, transport } = recordingTransport((index) =>
      index === 0 ? telegramError(400) : null
    );

    expect(await sendDigest(transport, 42, digest, silentLogger)).toEqual({
      format: "html_fallback",
      messageCount: 2
    });
    expect(sent).toEqual([
      { format: "html", text: "h1" },
      { format: "html", text: "h2" }
    ]);
  });

  test("does not fall back on a first-part error that is not a 400", async () => {
    for (const error of [telegramError(403), new Error("network down")]) {
      const { sent, transport } = recordingTransport((index) =>
        index === 0 ? error : null
      );

      await expect(sendDigest(transport, 42, digest, silentLogger)).rejects.toBe(error);
      expect(sent).toEqual([]);
    }
  });

  test("does not fall back when a later rich part fails, even with a 400", async () => {
    const error = telegramError(400);
    const { sent, transport } = recordingTransport((index) =>
      index === 1 ? error : null
    );

    await expect(sendDigest(transport, 42, digest, silentLogger)).rejects.toBe(error);
    expect(sent).toEqual([{ format: "rich", text: "r1" }]);
  });
});

describe("runDeliveryTask send path", () => {
  test("delivers a multi-part rich digest and advances the cursor once", async () => {
    const events = manyPushEvents(200);
    const { cursorWrites, store } = createStore(events);
    const { sent, transport } = recordingTransport();

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      transport,
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.format).toBe("rich");
    expect(result.messageCount).toBeGreaterThan(1);
    expect(sent).toHaveLength(result.messageCount);
    expect(sent.every((item) => item.format === "rich")).toBe(true);
    expect(cursorWrites).toHaveLength(1);
  });

  test("falls back to the HTML digest on a first-part 400 and still advances", async () => {
    const { cursorWrites, store } = createStore([pushEvent, releaseEvent]);
    const { sent, transport } = recordingTransport(() => telegramError(400));

    const result = await runDeliveryTask({
      subscriptionId: subscription.id,
      store,
      transport,
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(result.format).toBe("html_fallback");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.format).toBe("html");
    expect(sent[0]?.text).toContain("<b>GitHub activity digest</b>");
    expect(cursorWrites.map((date) => date.toISOString())).toEqual([
      "2026-05-20T12:10:00.000Z"
    ]);
  });

  test("sends the AI digest's own HTML version on fallback", async () => {
    const { store } = storeWithSubscription([pushEvent], aiSubscription);
    const { sent, transport } = recordingTransport(() => telegramError(400));

    await runDeliveryTask({
      subscriptionId: aiSubscription.id,
      store,
      transport,
      aiSummarizer: { isAvailable: () => true, generate: async () => "AI prose." },
      now: new Date("2026-05-20T13:00:00Z")
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("AI summary");
    expect(sent[0]?.text).toContain("AI prose.");
  });

  test("keeps the cursor when a later rich part fails", async () => {
    const { cursorWrites, store } = createStore(manyPushEvents(200));
    const { sent, transport } = recordingTransport((index) =>
      index === 1 ? telegramError(400) : null
    );

    await expect(
      runDeliveryTask({
        subscriptionId: subscription.id,
        store,
        transport,
        now: new Date("2026-05-20T13:00:00Z")
      })
    ).rejects.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent.some((item) => item.format === "html")).toBe(false);
    expect(cursorWrites).toEqual([]);
  });

  test("keeps the cursor when the HTML fallback also fails", async () => {
    const { cursorWrites, store } = createStore([pushEvent]);
    const transport: DeliveryTransport = {
      sendRich: async () => {
        throw telegramError(400);
      },
      sendHtml: async () => {
        throw telegramError(400);
      }
    };

    await expect(
      runDeliveryTask({
        subscriptionId: subscription.id,
        store,
        transport,
        now: new Date("2026-05-20T13:00:00Z")
      })
    ).rejects.toThrow();
    expect(cursorWrites).toEqual([]);
  });
});

describe("createDeliveryTransport", () => {
  test("sends rich messages without entity detection and HTML without previews", async () => {
    const calls: unknown[][] = [];
    const transport = createDeliveryTransport({
      sendRichMessage: async (...args) => {
        calls.push(["sendRichMessage", ...args]);
      },
      sendMessage: async (...args) => {
        calls.push(["sendMessage", ...args]);
      }
    });

    await transport.sendRich(42, "<p>rich</p>");
    await transport.sendHtml(42, "<b>html</b>");

    expect(calls).toEqual([
      ["sendRichMessage", 42, { html: "<p>rich</p>", skip_entity_detection: true }],
      ["sendMessage", 42, "<b>html</b>", { link_preview_options: { is_disabled: true } }]
    ]);
  });
});
