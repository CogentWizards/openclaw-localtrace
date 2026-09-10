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
 * price (see `estimateCostUsd` below), never a guessed one.
 *
 * Two separate ways to refresh it, for two separate audiences:
 * - A repo checkout can regenerate the bundled snapshot itself with
 *   `npm run update-pricing-table` (scripts/update-pricing-table.mjs),
 *   review the diff, and ship it in the next published version.
 * - Anyone with only the published package installed -- most users, once
 *   this is on npm -- doesn't have that dev script and can't wait for a
 *   new release every time a model is missing. `bin/update-pricing.js`
 *   (shipped in the package, runnable via
 *   `npx openclaw-localtrace-update-pricing`) fetches the same data and
 *   writes it to a fixed override path (`defaultOverridePath` below,
 *   or `--out <path>` + the plugin's own `pricingTableOverridePath`
 *   config) that this module checks at runtime and layers OVER the
 *   bundled table (override wins per provider/model, bundled still
 *   covers everything the override doesn't) -- no new release needed,
 *   and still no network access from the plugin itself, only from that
 *   one, explicitly-run command.
 *
 * OpenClaw's own cost-estimation machinery (`estimateAggregateUsageCost`/
 * `resolveModelCostConfig` in its compiled source) additionally layers in
 * the operator's own `models.json` overrides and per-provider config --
 * this table does not attempt to replicate that; it is a plain,
 * provider-published-rate estimate, nothing more.
 */

import os from "node:os";
import path from "node:path";
import pricingTableJson from "./pricing-table.json" with { type: "json" };

export interface PricingEntry {
  provider: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export type PricingTable = Record<string, PricingEntry>;

const bundledPricingTable = pricingTableJson as PricingTable;

/** Fixed default location an override file is read from (if present) and
 * the CLI writes to (unless given `--out`) -- a plain, predictable path
 * this module owns end-to-end, not a guess at any other component's
 * internal directory conventions. */
export const defaultOverridePath = path.join(
  os.homedir(),
  ".openclaw",
  "openclaw-localtrace",
  "pricing-table.json",
);

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

// LiteLLM's own key convention is inconsistent by provider: anthropic/
// openai/deepseek/mistral entries are bare model names ("claude-sonnet-5"),
// while gemini/xai entries keep a "provider/" prefix even for direct API
// access ("gemini/gemini-2.5-flash"). Normalizing to (provider, bareModel)
// once at load time means callers never have to know which convention a
// given provider happens to use.
function buildPricingIndex(table: PricingTable): Map<string, Map<string, PricingEntry>> {
  const byProviderAndModel = new Map<string, Map<string, PricingEntry>>();
  for (const [key, entry] of Object.entries(table)) {
    const slashIndex = key.indexOf("/");
    const bareModel = slashIndex >= 0 ? key.slice(slashIndex + 1) : key;
    let byModel = byProviderAndModel.get(entry.provider);
    if (!byModel) {
      byModel = new Map();
      byProviderAndModel.set(entry.provider, byModel);
    }
    byModel.set(bareModel, entry);
  }
  return byProviderAndModel;
}

const bundledIndex = buildPricingIndex(bundledPricingTable);

export interface UsageForCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type PricingResolver = (
  provider: string | undefined,
  model: string | undefined,
  usage: UsageForCost | undefined,
) => number | undefined;

function costFromEntry(entry: PricingEntry, usage: UsageForCost): number | undefined {
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
  return hasAnyTokens ? total : undefined;
}

/** Builds a resolver that checks `overrideTable` first (if given) and
 * falls back to the bundled snapshot -- an override entry for a
 * provider/model wins outright; anything the override doesn't cover
 * still resolves from the bundled table, so a small, partial override
 * (or one that's gone slightly stale itself) never regresses coverage
 * for everything else. */
export function createPricingResolver(overrideTable?: PricingTable): PricingResolver {
  const overrideIndex = overrideTable ? buildPricingIndex(overrideTable) : undefined;

  function lookup(index: Map<string, Map<string, PricingEntry>>, provider: string, model: string) {
    const providerKey = PROVIDER_ALIASES[provider] ?? provider;
    return index.get(providerKey)?.get(model);
  }

  return (provider, model, usage) => {
    if (!provider || !model || !usage) return undefined;
    const entry =
      (overrideIndex && lookup(overrideIndex, provider, model)) ??
      lookup(bundledIndex, provider, model);
    if (!entry) return undefined;
    return costFromEntry(entry, usage);
  };
}

/** The bundled-only resolver -- used whenever no override was loaded
 * (the default; see service.ts for how/when an override is read). */
export const estimateCostUsd: PricingResolver = createPricingResolver();
