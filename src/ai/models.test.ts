// Verifies model ranking from the models.dev catalog and the cached, probed model selection.
import { describe, expect, test } from "bun:test";

import {
  catalogUrl,
  cheapestSelectionTtlMs,
  createModelSelector,
  fallbackModel,
  liveModelsUrl,
  loadRankedModels,
  rankSummaryModels,
  recheckTtlMs,
  type RankedModel
} from "~/ai/models";
import type { SummaryModel } from "~/ai/protocols";

type CatalogEntry = Record<string, unknown>;

const entry = (id: string, input: number, output: number, extra: CatalogEntry = {}) => ({
  id,
  temperature: true,
  modalities: { input: ["text"], output: ["text"] },
  cost: { input, output },
  ...extra
});

// Mirrors the opencode-go slice of models.dev as of September 2026.
const catalog = {
  "opencode-go": {
    models: {
      "muse-spark-1.3-contributor": entry("muse-spark-1.3-contributor", 0.1, 0.2, {
        release_date: "2026-09-02",
        provider: { npm: "@ai-sdk/openai" },
        reasoning_options: [
          { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }
        ]
      }),
      "muse-spark-1.2-contributor": entry("muse-spark-1.2-contributor", 0.1, 0.2, {
        release_date: "2026-07-01",
        provider: { npm: "@ai-sdk/openai" },
        reasoning_options: [{ type: "effort", values: ["minimal", "low"] }]
      }),
      "mimo-v2.5": entry("mimo-v2.5", 0.14, 0.28, { reasoning_options: [] }),
      "qwen3.8-flash": entry("qwen3.8-flash", 0.15, 0.47, {
        provider: { npm: "@ai-sdk/anthropic" }
      }),
      "deepseek-v4-flash": entry("deepseek-v4-flash", 0.15, 0.6),
      "ox-alpha-free": entry("ox-alpha-free", 0, 0, { status: "deprecated" }),
      "strange-sdk": entry("strange-sdk", 0.01, 0.01, { provider: { npm: "@ai-sdk/google" } }),
      "image-only": entry("image-only", 0.01, 0.01, {
        modalities: { input: ["text"], output: ["image"] }
      }),
      "not-served": entry("not-served", 0.01, 0.01),
      "no-price": { id: "no-price", modalities: { input: ["text"], output: ["text"] } }
    }
  }
};

const live = [
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
  "mimo-v2.5",
  "qwen3.8-flash",
  "deepseek-v4-flash",
  "ox-alpha-free",
  "strange-sdk",
  "image-only",
  "no-price"
];

describe("rankSummaryModels", () => {
  test("orders served, priced, text models from cheapest to most expensive", () => {
    expect(rankSummaryModels(live, catalog).map((model) => model.id)).toEqual([
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor",
      "mimo-v2.5",
      "qwen3.8-flash",
      "deepseek-v4-flash"
    ]);
  });

  test("maps each model to the protocol and lowest effort it is served with", () => {
    const byId = new Map(rankSummaryModels(live, catalog).map((model) => [model.id, model]));

    expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({
      protocol: "responses",
      reasoningEffort: "minimal"
    });
    expect(byId.get("qwen3.8-flash")).toMatchObject({ protocol: "messages", reasoningEffort: null });
    expect(byId.get("deepseek-v4-flash")).toMatchObject({ protocol: "chat", reasoningEffort: null });
  });

  test("prices a digest from both input and output rates", () => {
    const [muse] = rankSummaryModels(live, catalog);

    // 1000 input tokens at $0.10/M plus 500 output tokens at $0.20/M.
    expect(muse!.costPerSummaryUsd).toBeCloseTo(0.0002, 10);
  });

  test("weighs output price, so a cheap-input model with pricey output ranks lower", () => {
    const ranked = rankSummaryModels(["cheap-in", "balanced"], {
      "opencode-go": {
        models: {
          "cheap-in": entry("cheap-in", 0.05, 2),
          balanced: entry("balanced", 0.2, 0.3)
        }
      }
    });

    expect(ranked.map((model) => model.id)).toEqual(["balanced", "cheap-in"]);
  });

  test("breaks price ties by newest release, then id", () => {
    const ranked = rankSummaryModels(["b", "a", "c"], {
      "opencode-go": {
        models: {
          a: entry("a", 1, 1, { release_date: "2026-01-01" }),
          b: entry("b", 1, 1, { release_date: "2026-01-01" }),
          c: entry("c", 1, 1, { release_date: "2026-05-01" })
        }
      }
    });

    expect(ranked.map((model) => model.id)).toEqual(["c", "a", "b"]);
  });

  test("respects a catalog that marks temperature unsupported", () => {
    const [model] = rankSummaryModels(["t"], {
      "opencode-go": { models: { t: entry("t", 1, 1, { temperature: false }) } }
    });

    expect(model!.supportsTemperature).toBe(false);
  });

  test("throws when the catalog lacks the opencode-go provider", () => {
    expect(() => rankSummaryModels(live, { openai: { models: {} } })).toThrow("opencode-go");
  });
});

describe("loadRankedModels", () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status });

  test("joins the live model list with catalog prices", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ranked = await loadRankedModels({
      apiKey: "key",
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: new Headers(init?.headers).get("authorization") });

        return url === liveModelsUrl
          ? jsonResponse({ data: [{ id: "deepseek-v4-flash" }, { id: "mimo-v2.5" }] })
          : jsonResponse(catalog);
      }
    });

    expect(ranked.map((model) => model.id)).toEqual(["mimo-v2.5", "deepseek-v4-flash"]);
    expect(seen).toContainEqual({ url: liveModelsUrl, auth: "Bearer key" });
    expect(seen.map((request) => request.url)).toContain(catalogUrl);
  });

  test("throws when either source fails", async () => {
    await expect(
      loadRankedModels({
        apiKey: "key",
        fetchImpl: async (url) =>
          url === catalogUrl ? jsonResponse({}, 503) : jsonResponse({ data: [] })
      })
    ).rejects.toThrow("503");
  });
});

const ranked = (...ids: string[]): RankedModel[] =>
  ids.map((id, index) => ({
    id,
    protocol: "chat",
    reasoningEffort: null,
    supportsTemperature: true,
    costPerSummaryUsd: (index + 1) / 10_000
  }));

const clock = () => {
  let current = 1_000_000;

  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
};

describe("createModelSelector", () => {
  test("picks the cheapest model that passes its probe and caches it for a day", async () => {
    const time = clock();
    let loads = 0;
    const probed: string[] = [];
    const selector = createModelSelector({
      now: time.now,
      loadModels: async () => {
        loads += 1;
        return ranked("cheap", "mid", "pricey");
      },
      probe: async (model) => {
        probed.push(model.id);
        return true;
      }
    });

    expect((await selector.getModel()).id).toBe("cheap");
    expect(selector.currentSelection()).toMatchObject({
      reason: "cheapest",
      expiresAt: time.now() + cheapestSelectionTtlMs
    });

    time.advance(cheapestSelectionTtlMs - 1);
    await selector.getModel();
    expect(loads).toBe(1);

    time.advance(1);
    await selector.getModel();
    expect(loads).toBe(2);
    // One batch per pick; later batch members were probed alongside the winner.
    expect(probed.filter((id) => id === "cheap")).toHaveLength(2);
  });

  test("skips a cheaper model that fails its probe and rechecks within the hour", async () => {
    const time = clock();
    let cheapWorks = false;
    const selector = createModelSelector({
      now: time.now,
      loadModels: async () => ranked("cheap", "mid"),
      probe: async (model) => model.id !== "cheap" || cheapWorks
    });

    expect((await selector.getModel()).id).toBe("mid");
    expect(selector.currentSelection()).toMatchObject({
      reason: "cheaper-model-failed",
      expiresAt: time.now() + recheckTtlMs
    });

    cheapWorks = true;
    time.advance(recheckTtlMs);

    expect((await selector.getModel()).id).toBe("cheap");
  });

  test("probes a second batch when the first batch all fails", async () => {
    const selector = createModelSelector({
      loadModels: async () => ranked("a", "b", "c", "d", "e"),
      probe: async (model) => model.id === "e"
    });

    expect((await selector.getModel()).id).toBe("e");
  });

  test("falls back when every probed model fails", async () => {
    const probed: string[] = [];
    const selector = createModelSelector({
      loadModels: async () => ranked("a", "b", "c", "d", "e", "f", "g"),
      probe: async (model) => {
        probed.push(model.id);
        return false;
      }
    });

    expect(await selector.getModel()).toEqual(fallbackModel);
    expect(selector.currentSelection()?.reason).toBe("fallback");
    // Caps the probe spend at six requests per pick.
    expect(probed).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("treats a probe that throws as a failed probe", async () => {
    const selector = createModelSelector({
      loadModels: async () => ranked("boom", "ok"),
      probe: async (model) => {
        if (model.id === "boom") {
          throw new Error("network");
        }
        return true;
      }
    });

    expect((await selector.getModel()).id).toBe("ok");
  });

  test("falls back for an hour when the model list cannot load", async () => {
    const time = clock();
    let fail = true;
    const selector = createModelSelector({
      now: time.now,
      loadModels: async () => {
        if (fail) {
          throw new Error("models.dev down");
        }
        return ranked("cheap");
      },
      probe: async () => true
    });

    expect(await selector.getModel()).toEqual(fallbackModel);

    fail = false;
    time.advance(recheckTtlMs - 1);
    expect(await selector.getModel()).toEqual(fallbackModel);

    time.advance(1);
    expect((await selector.getModel()).id).toBe("cheap");
  });

  test("shares one in-flight pick between concurrent callers", async () => {
    let loads = 0;
    const selector = createModelSelector({
      loadModels: async () => {
        loads += 1;
        return ranked("cheap");
      },
      probe: async () => true
    });

    const picks = await Promise.all([selector.getModel(), selector.getModel(), selector.getModel()]);

    expect(picks.map((model) => model.id)).toEqual(["cheap", "cheap", "cheap"]);
    expect(loads).toBe(1);
  });

  test("a reported failure moves to the next model and the rejected one returns after an hour", async () => {
    const time = clock();
    const selector = createModelSelector({
      now: time.now,
      loadModels: async () => ranked("cheap", "mid"),
      probe: async () => true
    });

    expect((await selector.getModel()).id).toBe("cheap");

    selector.reportFailure("cheap");
    expect((await selector.getModel()).id).toBe("mid");

    time.advance(recheckTtlMs);
    expect((await selector.getModel()).id).toBe("cheap");
  });

  test("a failure on the fallback model does not trigger a re-pick", async () => {
    let loads = 0;
    const selector = createModelSelector({
      loadModels: async () => {
        loads += 1;
        throw new Error("down");
      },
      probe: async () => true
    });

    await selector.getModel();
    selector.reportFailure(fallbackModel.id);
    await selector.getModel();

    expect(loads).toBe(1);
  });

  test("hands probes the full model so the right protocol is exercised", async () => {
    const probed: SummaryModel[] = [];
    const selector = createModelSelector({
      loadModels: async () => [
        {
          id: "muse",
          protocol: "responses",
          reasoningEffort: "minimal",
          supportsTemperature: true,
          costPerSummaryUsd: 0.0002
        }
      ],
      probe: async (model) => {
        probed.push(model);
        return true;
      }
    });

    expect(await selector.getModel()).toEqual({
      id: "muse",
      protocol: "responses",
      reasoningEffort: "minimal",
      supportsTemperature: true
    });
    expect(probed[0]).toMatchObject({ protocol: "responses", reasoningEffort: "minimal" });
  });
});
