#!/usr/bin/env node
/**
 * Shipped as this package's own bin entry (`openclaw-localtrace-update-pricing`
 * -- runnable via `npx openclaw-localtrace-update-pricing` whether or not
 * the package is separately installed) so that anyone with only the
 * published plugin -- no repo checkout, no dev tooling -- can still
 * refresh pricing data on their own machine without waiting for a new
 * release. See pricing.ts's own module docstring for how this fits
 * alongside the repo-only `npm run update-pricing-table` dev script.
 *
 * Writes to `defaultOverridePath` (a fixed location under
 * `~/.openclaw/openclaw-localtrace/`) unless told otherwise with --out;
 * the plugin checks that same default path automatically on Gateway
 * start, so the common case needs no config change at all -- just re-run
 * this, then restart the Gateway.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultOverridePath, type PricingEntry, type PricingTable, type PricingTableFile } from "./pricing.js";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Kept in sync with scripts/update-pricing-table.mjs's own filtering --
// see that file if these ever need to change; duplicated rather than
// shared because that script runs directly against source (pre-build),
// while this one ships as compiled output the published package carries.
const WANTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "vertex_ai-language-models",
  "xai",
  "deepseek",
  "mistral",
]);

const RESELLER_PREFIXES = [
  "azure/", "azure_ai/", "bedrock/", "bedrock_converse/", "vertex_ai/", "vertex_ai_beta/",
  "databricks/", "anyscale/", "together_ai/", "fireworks_ai/", "openrouter/", "groq/",
  "perplexity/", "cerebras/", "sagemaker/", "sagemaker_chat/", "watsonx/", "replicate/",
  "cloudflare/", "friendliai/", "nvidia_nim/", "deepinfra/", "nscale/", "novita/",
];

export const USAGE = `Usage: openclaw-localtrace-update-pricing [--out <path>] [--help]

Fetches a curated LiteLLM pricing snapshot and writes it as this plugin's
pricing-table override (defaults to ${defaultOverridePath}).

Options:
  --out <path>  Write the pricing table to a custom location instead of
                the plugin's default override path.
  -h, --help    Show this help message and exit, without fetching anything.`;

export interface ParsedArgs {
  help: boolean;
  outPath: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let outPath = defaultOverridePath;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--out requires a path argument");
      }
      outPath = value;
      i++;
      continue;
    }
    throw new Error(`unrecognized argument: ${arg}`);
  }
  return { help, outPath };
}

async function fetchPricingTable(): Promise<PricingTable> {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as Record<string, Record<string, unknown>>;

  const curated: PricingTable = {};
  for (const [key, entry] of Object.entries(data)) {
    if (typeof entry !== "object" || entry === null) continue;
    const provider = entry.litellm_provider;
    if (typeof provider !== "string" || !WANTED_PROVIDERS.has(provider)) continue;
    if (RESELLER_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const input = entry.input_cost_per_token;
    const output = entry.output_cost_per_token;
    if (typeof input !== "number" || typeof output !== "number") continue;
    const cacheRead = entry.cache_read_input_token_cost;
    const cacheWrite = entry.cache_creation_input_token_cost;
    const priced: PricingEntry = {
      cacheRead: typeof cacheRead === "number" ? cacheRead : null,
      cacheWrite: typeof cacheWrite === "number" ? cacheWrite : null,
      input,
      output,
      provider,
    };
    curated[key] = priced;
  }
  return curated;
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  const { outPath } = parsed;
  console.log(`Fetching pricing data from ${SOURCE_URL} ...`);
  const table = await fetchPricingTable();
  const byProvider: Record<string, number> = {};
  for (const entry of Object.values(table)) {
    byProvider[entry.provider] = (byProvider[entry.provider] ?? 0) + 1;
  }

  const file: PricingTableFile = { generatedAt: new Date().toISOString(), entries: table };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(file, null, 2) + "\n", "utf-8");

  console.log(`Wrote ${Object.keys(table).length} entries to ${outPath} (generatedAt: ${file.generatedAt})`);
  console.log("By provider:", byProvider);
  if (outPath === defaultOverridePath) {
    console.log(
      "This is the plugin's default override location -- restart the OpenClaw Gateway " +
        "and it will be picked up automatically, no config change needed.",
    );
  } else {
    console.log(
      `Custom output path -- set plugins.entries.openclaw-localtrace.config.pricingTableOverridePath ` +
        `to "${outPath}" (openclaw config set ...) and restart the Gateway for this to take effect.`,
    );
  }
}

// Only run when invoked directly (as the CLI/bin entry) -- never as a side
// effect of another module importing from this file (e.g. a test importing
// parseArgs), which would otherwise fetch real pricing data and write a
// real file as an accidental side effect of module load.
//
// process.argv[1] must be realpath'd before comparing: npm always wires a
// bin command up as a symlink (node_modules/.bin/<name> -> the real dist
// file, and that's also exactly what `npx`/global installs run through),
// so argv[1] is the symlink path while import.meta.url resolves through it
// to the real file -- comparing the raw, un-resolved argv[1] against
// import.meta.url therefore never matches for any real installed/npx
// invocation, only for a same-directory `node dist/update-pricing-cli.js`
// call. That gap wasn't caught before shipping because verification only
// exercised the direct-file form, never the actual symlinked bin path.
function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((error: unknown) => {
    console.error(`openclaw-localtrace-update-pricing failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
