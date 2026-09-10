/**
 * A bundled, static snapshot of per-model token pricing -- NOT a live
 * network fetch. This is a deliberate departure from a live lookup (the
 * kind OpenClaw's own internal cost-estimation machinery does, pulling
 * from several public sources including LiteLLM's community-maintained
 * pricing JSON, OpenRouter's models API, and a few inference-provider
 * catalogs), made explicitly to preserve this plugin's one real
 * architectural promise: no code path in it can reach the network at
 * all. A live-fetched pricing table would still be an *inbound* call
 * only (never sending data out), but even that is a meaningful
 * departure from "no network path exists," so it stays out of scope
 * here in favor of a table that goes stale instead.
 *
 * `pricing-table.json` is a curated subset of LiteLLM's own public
 * `model_prices_and_context_window.json`
 * (https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json),
 * restricted to direct-API entries (no Azure/Bedrock/Vertex/other
 * reseller-hosted variants) for six major providers: anthropic, openai,
 * gemini, vertex_ai-language-models, xai, deepseek, mistral. It WILL go
 * stale as new models ship -- an unrecognized model simply gets no
 * price (see `estimateCostUsd` below), never a guessed one. Regenerate
 * with `npm run update-pricing-table` (see scripts/update-pricing-table.mjs),
 * review the diff, and commit it like any other change.
 *
 * OpenClaw's own cost-estimation machinery (`estimateAggregateUsageCost`/
 * `resolveModelCostConfig` in its compiled source) additionally layers in
 * the operator's own `models.json` overrides and per-provider config --
 * this table does not attempt to replicate that; it is a plain,
 * provider-published-rate estimate, nothing more.
 */

import pricingTableJson from "./pricing-table.json" with { type: "json" };

interface PricingEntry {
  provider: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

const pricingTable = pricingTableJson as Record<string, PricingEntry>;

// LiteLLM's own key convention is inconsistent by provider: anthropic/
// openai/deepseek/mistral entries are bare model names ("claude-sonnet-5"),
// while gemini/xai entries keep a "provider/" prefix even for direct API
// access ("gemini/gemini-2.5-flash"). Normalizing to (provider, bareModel)
// once at load time means callers never have to know which convention a
// given provider happens to use.
interface NormalizedEntry {
  bareModel: string;
  pricing: PricingEntry;
}

const byProviderAndModel = new Map<string, Map<string, PricingEntry>>();
for (const [key, entry] of Object.entries(pricingTable)) {
  const slashIndex = key.indexOf("/");
  const bareModel = slashIndex >= 0 ? key.slice(slashIndex + 1) : key;
  let byModel = byProviderAndModel.get(entry.provider);
  if (!byModel) {
    byModel = new Map();
    byProviderAndModel.set(entry.provider, byModel);
  }
  byModel.set(bareModel, entry);
}

// OpenClaw's own provider id for a given service doesn't always match
// LiteLLM's `litellm_provider` slug exactly (e.g. OpenClaw may call
// Google's models "google" where LiteLLM calls the same rows "gemini").
// Best-effort, not exhaustive -- an unmapped provider id simply finds no
// entry, same as an unmapped model.
const PROVIDER_ALIASES: Record<string, string> = {
  google: "gemini",
  "vertex-ai": "vertex_ai-language-models",
  vertexai: "vertex_ai-language-models",
};

function resolveEntry(provider: string, model: string): PricingEntry | undefined {
  const providerKey = PROVIDER_ALIASES[provider] ?? provider;
  const byModel = byProviderAndModel.get(providerKey);
  if (!byModel) return undefined;
  return byModel.get(model);
}

export interface UsageForCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Estimated USD cost for one call's token usage, from the bundled
 * pricing snapshot -- undefined (never a guessed number) when the
 * provider/model isn't in the table, or usage carries no tokens at all. */
export function estimateCostUsd(
  provider: string | undefined,
  model: string | undefined,
  usage: UsageForCost | undefined,
): number | undefined {
  if (!provider || !model || !usage) return undefined;
  const entry = resolveEntry(provider, model);
  if (!entry) return undefined;

  let total = 0;
  let hasAnyTokens = false;
  if (usage.input !== undefined) {
    total += usage.input * entry.input;
    hasAnyTokens = true;
  }
  if (usage.output !== undefined) {
    total += usage.output * entry.output;
    hasAnyTokens = true;
  }
  if (usage.cacheRead !== undefined && entry.cacheRead !== null) {
    total += usage.cacheRead * entry.cacheRead;
    hasAnyTokens = true;
  }
  if (usage.cacheWrite !== undefined && entry.cacheWrite !== null) {
    total += usage.cacheWrite * entry.cacheWrite;
    hasAnyTokens = true;
  }
  if (!hasAnyTokens) return undefined;
  return total;
}
