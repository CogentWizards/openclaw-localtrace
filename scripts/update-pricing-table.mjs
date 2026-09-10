#!/usr/bin/env node
/**
 * Regenerates src/pricing-table.json from a fresh copy of LiteLLM's
 * public pricing data -- the source pricing.ts's own docstring already
 * points at, restated here so that pointer resolves to something real:
 * https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *
 * This table WILL go stale as new models ship -- there is no CI job or
 * schedule that re-runs this automatically, by design (this plugin's one
 * real architectural promise is that no code path in it reaches the
 * network; a scheduled auto-update would be a standing network
 * dependency in a different place, not a one-off developer action). Run
 * this by hand periodically, or whenever a model your own usage depends
 * on is missing from a `redundo adapt --summary` run's cost coverage,
 * review the diff, and commit it like any other change.
 *
 *   npm run update-pricing-table
 *
 * Restricted to direct-API entries (no Azure/Bedrock/Vertex/other
 * reseller-hosted variants) for six major providers -- see
 * WANTED_PROVIDERS below. Extend that set (and re-run) to cover more
 * providers; this was never meant to be the full ~3900-entry upstream
 * file, just enough for the models real OpenClaw usage actually hits.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const WANTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "vertex_ai-language-models",
  "xai",
  "deepseek",
  "mistral",
]);

// Keys under these prefixes are the same underlying model re-sold through
// a hosting/integration layer (Azure, Bedrock, Vertex's REST surface,
// third-party inference resellers, ...) -- excluded so the table only
// ever contains genuine direct-API pricing, matching what OpenClaw's own
// `openclaw.provider`/`openclaw.model` attributes actually name.
const RESELLER_PREFIXES = [
  "azure/",
  "azure_ai/",
  "bedrock/",
  "bedrock_converse/",
  "vertex_ai/",
  "vertex_ai_beta/",
  "databricks/",
  "anyscale/",
  "together_ai/",
  "fireworks_ai/",
  "openrouter/",
  "groq/",
  "perplexity/",
  "cerebras/",
  "sagemaker/",
  "sagemaker_chat/",
  "watsonx/",
  "replicate/",
  "cloudflare/",
  "friendliai/",
  "nvidia_nim/",
  "deepinfra/",
  "nscale/",
  "novita/",
];

async function main() {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();

  const curated = {};
  for (const [key, entry] of Object.entries(data)) {
    if (typeof entry !== "object" || entry === null) continue;
    const provider = entry.litellm_provider;
    if (!WANTED_PROVIDERS.has(provider)) continue;
    if (RESELLER_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const input = entry.input_cost_per_token;
    const output = entry.output_cost_per_token;
    if (input === undefined || input === null || output === undefined || output === null) continue;
    // Alphabetized fields, matching JSON.stringify's own key order --
    // keeps re-runs of this script producing a minimal diff when pricing
    // hasn't actually changed, instead of reshuffling every entry.
    curated[key] = {
      cacheRead: entry.cache_read_input_token_cost ?? null,
      cacheWrite: entry.cache_creation_input_token_cost ?? null,
      input,
      output,
      provider,
    };
  }

  const sortedKeys = Object.keys(curated).sort();
  const sorted = {};
  for (const key of sortedKeys) sorted[key] = curated[key];

  // generatedAt is load-bearing, not decorative -- see pricing.ts's own
  // module docstring on why a stale-but-present price is a worse failure
  // than a missing one, and how this timestamp is what makes that
  // staleness visible (a startup warning past 30 days, and a per-span
  // attribute in every capture) instead of silent.
  const file = { generatedAt: new Date().toISOString(), entries: sorted };

  const outPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "pricing-table.json",
  );
  await writeFile(outPath, JSON.stringify(file, null, 2) + "\n", "utf-8");

  const byProvider = {};
  for (const entry of Object.values(sorted)) {
    byProvider[entry.provider] = (byProvider[entry.provider] ?? 0) + 1;
  }
  console.log(`Wrote ${sortedKeys.length} entries to ${outPath} (generatedAt: ${file.generatedAt})`);
  console.log("By provider:", byProvider);
  console.log("Review the diff (git diff src/pricing-table.json) before committing.");
}

main().catch((error) => {
  console.error(`update-pricing-table failed: ${error.message}`);
  process.exitCode = 1;
});
