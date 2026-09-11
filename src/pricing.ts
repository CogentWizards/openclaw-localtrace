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
 * Checked directly (not assumed) whether OpenClaw's own resolved,
 * internal pricing catalog is reachable instead of maintaining a
 * separate one: it isn't. Its actual computation
 * (`estimateAggregateUsageCost`/`resolveModelCostConfig`) lives in a
 * purely internal, content-hashed chunk with no stable import path; the
 * public `plugin-sdk/model-catalog-pricing` subpath only exports
 * normalization helpers for a plugin *submitting* its own pricing, not a
 * way to *read* the resolved one; there is no on-disk cache (the full
 * SQLite schema and the `~/.openclaw` tree were both checked); and
 * neither `openclaw models list --json` nor `openclaw models status
 * --json` includes a single price field. This plugin's own bundled/
 * fetched table -- distinct from, and unrelated to, OpenClaw's own
 * internal one -- is genuinely the only option, not a fallback settled
 * for.
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
 * Staleness of a *recognized* model's price is a different, worse
 * problem: unlike a missing model (which visibly produces no estimate
 * at all), a provider quietly changing a rate produces a confidently
 * wrong number that looks exactly like a correct one. Every pricing
 * file this module reads or writes therefore carries its own
 * `generatedAt` timestamp (see `PricingTableFile`), and both this
 * plugin's own currently-active table's age (surfaced via
 * `activePricingContext().generatedAt` -> a span attribute -- see
 * spans.ts) and a Gateway-startup warning past 30 days old (see
 * service.ts's `pricingStalenessWarning`) make that age visible rather
 * than silent. This is specifically *this plugin's own* pricing data --
 * unrelated to, and not to be confused with, whatever pricing catalog
 * OpenClaw itself uses internally (see above).
 *
 * Two separate ways to refresh it, for two separate audiences:
 * - A repo checkout can regenerate the bundled snapshot itself with
 *   `npm run update-pricing-table` (scripts/update-pricing-table.mjs),
 *   review the diff, and ship it in the next published version.
 * - Anyone with only the published package installed -- most users, once
 *   this is on npm -- doesn't have that dev script and can't wait for a
 *   new release every time a model is missing or a price has drifted.
 *   `npx -p @cogentwizards/openclaw-localtrace openclaw-localtrace-update-pricing`
 *   (shipped in the package)
 *   fetches the same data and writes it to a fixed override path
 *   (`defaultOverridePath` below, or `--out <path>` + the plugin's own
 *   `pricingTableOverridePath` config) that this module checks at
 *   runtime and layers OVER the bundled table (override wins per
 *   provider/model, bundled still covers everything the override
 *   doesn't) -- no new release needed, and still no network access from
 *   the plugin itself, only from that one, explicitly-run command.
 *
 * OpenClaw's own cost-estimation machinery additionally layers in the
 * operator's own `models.json` overrides and per-provider config -- this
 * table does not attempt to replicate that; it is a plain,
 * provider-published-rate estimate, nothing more.
 */

import os from "node:os";
import path from "node:path";
import pricingTableFileJson from "./pricing-table.json" with { type: "json" };

export interface PricingEntry {
  provider: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export type PricingTable = Record<string, PricingEntry>;

/** On-disk shape for both the bundled snapshot and any override file --
 * generatedAt is load-bearing (see module docstring on staleness), not
 * decorative, so both writers (scripts/update-pricing-table.mjs,
 * update-pricing-cli.ts) and this module's own readers agree on it. */
export interface PricingTableFile {
  generatedAt: string; // ISO 8601, UTC
  entries: PricingTable;
}

const bundledPricingTableFile = pricingTableFileJson as PricingTableFile;

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

/** Warn once at Gateway startup when the *active* pricing table (the
 * override if one was loaded, else the bundled snapshot) is older than
 * this -- see service.ts's pricingStalenessWarning. A provider changing
 * a rate is a real, if infrequent, event; 30 days balances catching it
 * against warning on every single startup. */
export const STALENESS_WARNING_DAYS = 30;

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

const bundledIndex = buildPricingIndex(bundledPricingTableFile.entries);

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

/** A resolver bundled together with the generatedAt timestamp of
 * whichever table is actually backing it -- so a consumer (SpanMapper)
 * can attach both the cost estimate AND its own age to the same span in
 * one place, instead of tracking the timestamp separately by hand. */
export interface PricingContext {
  estimateCostUsd: PricingResolver;
  generatedAt: string;
}

export function createPricingContext(override?: PricingTableFile): PricingContext {
  return {
    estimateCostUsd: createPricingResolver(override?.entries),
    generatedAt: override?.generatedAt ?? bundledPricingTableFile.generatedAt,
  };
}

/** The bundled-only context -- used whenever no override was loaded. */
export const defaultPricingContext: PricingContext = createPricingContext();

/** Age of `generatedAt` in whole days, for both the startup warning
 * (service.ts) and the per-span attribute (spans.ts) -- one shared
 * definition of "how old" so the two surfaces the user asked for always
 * agree with each other. */
export function pricingAgeDays(generatedAt: string, now: number = Date.now()): number {
  const generatedMs = Date.parse(generatedAt);
  if (Number.isNaN(generatedMs)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - generatedMs) / (24 * 60 * 60 * 1000));
}
