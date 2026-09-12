// Picks the cheapest opencode Go model that can write a digest summary, priced from models.dev.
import { z } from "zod";

import {
  lowestReasoningEffort,
  type ApiProtocol,
  type SummaryModel
} from "~/ai/protocols";
import { logger } from "~/lib/logger";

// opencode publishes its Go prices through models.dev; its own /models endpoint lists ids only.
export const catalogUrl = "https://models.dev/api.json";
export const liveModelsUrl = "https://opencode.ai/zen/go/v1/models";
const catalogProviderId = "opencode-go";
const loadTimeoutMs = 15_000;

// One digest is about 900 prompt tokens and a few hundred output tokens, reasoning included.
const expectedInputTokens = 1_000;
const expectedOutputTokens = 500;

// A pick that is the cheapest listed model holds for a day. Anything else (a cheaper model
// failed its probe, or we fell back) is rechecked hourly so a cheap model returns quickly.
export const cheapestSelectionTtlMs = 24 * 60 * 60 * 1_000;
export const recheckTtlMs = 60 * 60 * 1_000;
const probeBatchSize = 3;
const maxProbedModels = 6;

export const fallbackModel: SummaryModel = {
  id: "deepseek-v4-flash",
  protocol: "chat",
  reasoningEffort: null,
  supportsTemperature: true
};

export type RankedModel = SummaryModel & {
  costPerDigestUsd: number;
};

const catalogModelSchema = z.object({
  id: z.string().min(1),
  release_date: z.string().optional(),
  status: z.string().optional(),
  temperature: z.boolean().optional(),
  reasoning_options: z
    .array(z.object({ type: z.string(), values: z.array(z.string()).optional() }))
    .optional(),
  modalities: z
    .object({ input: z.array(z.string()), output: z.array(z.string()) })
    .optional(),
  provider: z.object({ npm: z.string().optional() }).optional(),
  cost: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() })
});

const liveModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() }))
});

// The catalog's provider package says which endpoint serves the model.
const protocolForPackage = (npm: string | undefined): ApiProtocol | null => {
  if (npm === undefined || npm === "@ai-sdk/openai-compatible") {
    return "chat";
  }

  if (npm === "@ai-sdk/openai") {
    return "responses";
  }

  if (npm === "@ai-sdk/anthropic") {
    return "messages";
  }

  return null;
};

export const rankSummaryModels = (
  liveModelIds: Iterable<string>,
  catalog: unknown
): RankedModel[] => {
  const live = new Set(liveModelIds);
  const provider = (catalog as Record<string, unknown> | null)?.[catalogProviderId];
  const models = (provider as { models?: unknown } | undefined)?.models;

  if (typeof models !== "object" || models === null) {
    throw new Error(`models.dev catalog has no ${catalogProviderId} provider`);
  }

  const ranked: (RankedModel & { releaseDate: string })[] = [];

  for (const raw of Object.values(models)) {
    const parsed = catalogModelSchema.safeParse(raw);

    if (!parsed.success) {
      continue;
    }

    const entry = parsed.data;
    const protocol = protocolForPackage(entry.provider?.npm);
    const textInOut =
      entry.modalities === undefined ||
      (entry.modalities.input.includes("text") && entry.modalities.output.includes("text"));

    if (!live.has(entry.id) || entry.status === "deprecated" || protocol === null || !textInOut) {
      continue;
    }

    const effortValues =
      entry.reasoning_options?.find((option) => option.type === "effort")?.values ?? [];

    ranked.push({
      id: entry.id,
      protocol,
      reasoningEffort: protocol === "responses" ? lowestReasoningEffort(effortValues) : null,
      supportsTemperature: entry.temperature ?? true,
      costPerDigestUsd:
        (entry.cost.input * expectedInputTokens + entry.cost.output * expectedOutputTokens) /
        1_000_000,
      releaseDate: entry.release_date ?? ""
    });
  }

  // Same price: prefer the newer release, then a stable id order.
  ranked.sort(
    (left, right) =>
      left.costPerDigestUsd - right.costPerDigestUsd ||
      right.releaseDate.localeCompare(left.releaseDate) ||
      left.id.localeCompare(right.id)
  );

  return ranked.map(({ releaseDate: _releaseDate, ...model }) => model);
};

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export const loadRankedModels = async (options: {
  fetchImpl: FetchImpl;
  apiKey: string;
}): Promise<RankedModel[]> => {
  const [liveResponse, catalogResponse] = await Promise.all([
    options.fetchImpl(liveModelsUrl, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(loadTimeoutMs)
    }),
    options.fetchImpl(catalogUrl, { signal: AbortSignal.timeout(loadTimeoutMs) })
  ]);

  if (!liveResponse.ok) {
    throw new Error(`opencode Go model list returned ${liveResponse.status}`);
  }

  if (!catalogResponse.ok) {
    throw new Error(`models.dev catalog returned ${catalogResponse.status}`);
  }

  const live = liveModelsSchema.parse(await liveResponse.json());

  return rankSummaryModels(
    live.data.map((model) => model.id),
    await catalogResponse.json()
  );
};

export type ModelSelection = {
  model: SummaryModel;
  costPerDigestUsd: number | null;
  reason: "cheapest" | "cheaper-model-failed" | "fallback";
  expiresAt: number;
};

export type ModelSelector = {
  getModel: () => Promise<SummaryModel>;
  // A digest request showed the model cannot produce summaries (bad request, truncation).
  reportFailure: (modelId: string) => void;
  currentSelection: () => ModelSelection | null;
};

export type ModelSelectorDeps = {
  loadModels: () => Promise<RankedModel[]>;
  probe: (model: SummaryModel) => Promise<boolean>;
  now?: () => number;
};

export const createModelSelector = (deps: ModelSelectorDeps): ModelSelector => {
  const now = deps.now ?? Date.now;
  const rejectedUntil = new Map<string, number>();
  let selection: ModelSelection | null = null;
  let inFlight: Promise<SummaryModel> | null = null;

  const isRejected = (modelId: string): boolean => (rejectedUntil.get(modelId) ?? 0) > now();

  const fallbackSelection = (): ModelSelection => ({
    model: fallbackModel,
    costPerDigestUsd: null,
    reason: "fallback",
    expiresAt: now() + recheckTtlMs
  });

  const pickModel = async (): Promise<ModelSelection> => {
    let ranked: RankedModel[];

    try {
      ranked = await deps.loadModels();
    } catch (error) {
      logger.warn(
        { err: error, model: fallbackModel.id },
        "ai summary model list unavailable, using fallback model"
      );

      return fallbackSelection();
    }

    const candidates = ranked.filter((model) => !isRejected(model.id)).slice(0, maxProbedModels);

    for (let start = 0; start < candidates.length; start += probeBatchSize) {
      const batch = candidates.slice(start, start + probeBatchSize);
      // Probing a batch in parallel bounds the wait to one request timeout per batch.
      const results = await Promise.all(batch.map((model) => deps.probe(model).catch(() => false)));
      const winnerIndex = results.indexOf(true);
      const failed = batch.slice(0, winnerIndex === -1 ? batch.length : winnerIndex);

      if (failed.length > 0) {
        logger.warn(
          { models: failed.map((model) => model.id) },
          "ai summary model probe failed"
        );
      }

      const winner = batch[winnerIndex];

      if (winner !== undefined) {
        const cheapest = winner.id === ranked[0]?.id;

        logger.info(
          {
            model: winner.id,
            protocol: winner.protocol,
            cost_per_digest_usd: winner.costPerDigestUsd,
            cheapest_listed: ranked[0]?.id,
            ranked_count: ranked.length
          },
          "ai summary model selected"
        );

        return {
          model: {
            id: winner.id,
            protocol: winner.protocol,
            reasoningEffort: winner.reasoningEffort,
            supportsTemperature: winner.supportsTemperature
          },
          costPerDigestUsd: winner.costPerDigestUsd,
          reason: cheapest ? "cheapest" : "cheaper-model-failed",
          expiresAt: now() + (cheapest ? cheapestSelectionTtlMs : recheckTtlMs)
        };
      }
    }

    logger.warn(
      { probed: candidates.map((model) => model.id), model: fallbackModel.id },
      "no ai summary model passed its probe, using fallback model"
    );

    return fallbackSelection();
  };

  const getModel = async (): Promise<SummaryModel> => {
    if (selection !== null && selection.expiresAt > now() && !isRejected(selection.model.id)) {
      return selection.model;
    }

    inFlight ??= pickModel()
      .then((picked) => {
        selection = picked;

        return picked.model;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  const reportFailure = (modelId: string): void => {
    // The fallback is the last resort, so rejecting it would only force pointless re-probes.
    if (modelId === fallbackModel.id && selection?.reason === "fallback") {
      return;
    }

    rejectedUntil.set(modelId, now() + recheckTtlMs);
    logger.warn({ model: modelId }, "ai summary model rejected after a failed digest");
  };

  return {
    getModel,
    reportFailure,
    currentSelection: () => selection
  };
};
