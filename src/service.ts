import { readFile } from "node:fs/promises";
import path from "node:path";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";
import { writeOtlpBatch } from "./file-writer.js";
import { TurnCostMapper } from "./metrics.js";
import { attributesToOtlp, metricsDocument, type OtlpKeyValue } from "./otlp-json.js";
import {
  createPricingContext,
  defaultPricingContext,
  pricingAgeDays,
  STALENESS_WARNING_DAYS,
  type PricingContext,
  type PricingTableFile,
} from "./pricing.js";
import { sweepRetention } from "./retention.js";
import type { RuntimeHandle } from "./runtime-handle.js";
import { FileSpanExporter } from "./span-exporter.js";
import { SpanMapper } from "./spans.js";

export const PLUGIN_ID = "openclaw-localtrace";

// Hourly, not on every write -- see retention.ts's own docstring for why
// a sweep on every event would mean stat-ing the whole output directory
// far more often than necessary.
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function pluginConfig(ctx: OpenClawPluginServiceContext): Record<string, unknown> | undefined {
  return ctx.config.plugins?.entries?.[PLUGIN_ID]?.config;
}

function pluginHooksConfig(ctx: OpenClawPluginServiceContext): Record<string, unknown> | undefined {
  return ctx.config.plugins?.entries?.[PLUGIN_ID]?.hooks;
}

/** Faithful replay of OpenClaw's own resolveConversationAccessAllowed for
 * a non-bundled plugin (this plugin is never "bundled", so the simpler
 * branch always applies): true only when the operator has explicitly set
 * hooks.allowConversationAccess to true. Confirmed directly from
 * OpenClaw's compiled hook-policy-decisions.ts, not inferred -- see
 * spans.ts's own module docstring for how that was found. */
export function hasConversationAccess(hooksConfig: Record<string, unknown> | undefined): boolean {
  return hooksConfig?.allowConversationAccess === true;
}

/**
 * The two-config-surface trap: captureContent/captureIdentifiers live
 * under plugins.entries.<id>.config, but the permission that actually
 * unlocks the hooks those two options depend on
 * (llm_input/llm_output/before_agent_run/agent_end) lives under a
 * *different* top-level key, plugins.entries.<id>.hooks. Turning on the
 * first without the second doesn't error -- it just silently produces a
 * thinner capture than the operator asked for, discovered later (if at
 * all) as unexpectedly low content/cost coverage in a redundo report.
 * This is the one misconfiguration worth a loud, explicit startup
 * warning rather than a quiet degradation: it's exactly the failure mode
 * a real live-Gateway walkthrough of this plugin surfaced as the single
 * most likely way to end up with a confusing result.
 *
 * Returns undefined when there's nothing to warn about -- either
 * permission is already granted, or neither option is even on (a
 * deliberately minimal-capture setup, not a misconfiguration).
 */
export function conversationAccessWarning(
  captureContent: boolean,
  captureIdentifiers: boolean,
  granted: boolean,
): string | undefined {
  if (granted) return undefined;
  if (!captureContent && !captureIdentifiers) return undefined;

  const wants: string[] = [];
  if (captureContent) wants.push("captureContent");
  if (captureIdentifiers) wants.push("captureIdentifiers");

  return (
    `openclaw-localtrace: config.${wants.join(" and config.")} ${wants.length > 1 ? "are" : "is"} on, ` +
    "but plugins.entries.openclaw-localtrace.hooks.allowConversationAccess is not set to true. " +
    "llm.call spans -- prompt/response content, per-call gen_ai.usage.cost_usd estimates, and the " +
    "run-level workflow label -- will be silently skipped for every turn as a result. Tool-call " +
    "content, the write/mutation signal, and session/run identifiers on model.call/tool.execution " +
    "spans are unaffected and will still work. Fix with: openclaw config set " +
    "plugins.entries.openclaw-localtrace.hooks.allowConversationAccess true (then restart the Gateway)."
  );
}

function buildResourceAttributes(): OtlpKeyValue[] {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: PLUGIN_ID });
  return attributesToOtlp(resource.attributes);
}

/** Loads a pricing override file, if one exists at `overridePath` -- see
 * pricing.ts's own module docstring for the two audiences this serves
 * (a repo checkout regenerating the bundled table vs. anyone with only
 * the published package installed, who can't wait for a new release).
 * A missing file is the normal default state (no override configured,
 * or the update command was never run) and produces no log at all;
 * only a file that exists but fails to parse is worth a warning -- that
 * is a real misconfiguration, not an absence. */
export async function loadPricingContext(
  overridePath: string,
  logger: OpenClawPluginServiceContext["logger"],
): Promise<PricingContext> {
  let raw: string;
  try {
    raw = await readFile(overridePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPricingContext;
    logger.warn(`openclaw-localtrace: could not read pricing override at ${overridePath}: ${String(error)}`);
    return defaultPricingContext;
  }
  try {
    const overrideFile = JSON.parse(raw) as PricingTableFile;
    logger.info(`openclaw-localtrace: loaded a pricing override from ${overridePath} (generatedAt: ${overrideFile.generatedAt})`);
    return createPricingContext(overrideFile);
  } catch (error) {
    logger.warn(`openclaw-localtrace: pricing override at ${overridePath} is not valid JSON, ignoring it: ${String(error)}`);
    return defaultPricingContext;
  }
}

/**
 * Warn at startup when this plugin's OWN pricing data -- the file the
 * bundled/fetched snapshot described in pricing.ts's module docstring,
 * entirely distinct from OpenClaw's own internal pricing catalog -- is
 * older than STALENESS_WARNING_DAYS. A missing model is visible (no
 * cost_usd at all); a stale-but-present price is not: it produces a
 * confident, plausible-looking dollar figure indistinguishable from a
 * correct one. This is the one signal that makes that risk visible
 * instead of silent, alongside the per-span openclaw.pricingTableGeneratedAt
 * attribute every priced record already carries (see spans.ts) -- so
 * the age is visible both at startup and in every redundo report, not
 * just one or the other.
 */
export function pricingStalenessWarning(
  generatedAt: string,
  now: number = Date.now(),
): string | undefined {
  const ageDays = pricingAgeDays(generatedAt, now);
  if (ageDays <= STALENESS_WARNING_DAYS) return undefined;
  return (
    `openclaw-localtrace: this plugin's own pricing data (NOT OpenClaw's built-in pricing) is ` +
    `${ageDays} day(s) old (generated ${generatedAt}) -- provider rates may have changed since ` +
    "then, and gen_ai.usage.cost_usd estimates could be off as a result. Refresh with: npx " +
    "openclaw-localtrace-update-pricing (then restart the Gateway)."
  );
}

/**
 * Owns the OTel provider/exporter and retention-sweep lifecycle, keyed
 * to config.enabled and hot-reloadable the same way as before. Does NOT
 * subscribe to anything itself -- event delivery now comes through
 * hooks registered directly on the plugin api (see index.ts), which
 * write into the shared `handle` this service populates on start() and
 * clears on stop().
 */
export function createLocaltraceService(handle: RuntimeHandle): OpenClawPluginService {
  let provider: BasicTracerProvider | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  return {
    id: PLUGIN_ID,
    reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}.config`] },

    async start(ctx: OpenClawPluginServiceContext) {
      // A dedicated "traces" subdir, not the plugin's state dir root directly --
      // keeps rotating capture batches visually and operationally separate
      // from the plugin's own singleton files (pricing-table.json) living
      // alongside it in ctx.stateDir/PLUGIN_ID.
      const defaultOutputDir = path.join(ctx.stateDir, PLUGIN_ID, "traces");
      const config = resolveConfig(pluginConfig(ctx), defaultOutputDir);
      if (!config.enabled) return;

      const warning = conversationAccessWarning(
        config.captureContent,
        config.captureIdentifiers,
        hasConversationAccess(pluginHooksConfig(ctx)),
      );
      if (warning) ctx.logger.warn(warning);

      const resourceAttributes = buildResourceAttributes();
      const exporter = new FileSpanExporter(config.outputDir, resourceAttributes);
      provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: PLUGIN_ID }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });

      const pricingContext = await loadPricingContext(config.pricingTableOverridePath, ctx.logger);
      const stalenessWarning = pricingStalenessWarning(pricingContext.generatedAt);
      if (stalenessWarning) ctx.logger.warn(stalenessWarning);

      handle.current = {
        outputDir: config.outputDir,
        spanMapper: new SpanMapper(provider, config, pricingContext),
        turnCostMapper: new TurnCostMapper(config),
      };

      const runSweep = () => {
        sweepRetention(config.outputDir, config.maxAgeDays, config.maxOutputBytes)
          .then((result) => {
            if (result.deletedFiles > 0) {
              ctx.logger.info(
                `openclaw-localtrace: retention sweep deleted ${result.deletedFiles} file(s), ${result.deletedBytes} byte(s)`,
              );
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(`openclaw-localtrace: retention sweep failed: ${String(error)}`);
          });
      };
      runSweep();
      sweepTimer = setInterval(runSweep, RETENTION_SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
    },

    async stop() {
      handle.current = undefined;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
      if (provider) {
        await provider.shutdown(); // flushes the BatchSpanProcessor before actually stopping
        provider = undefined;
      }
    },
  };
}

/** Writes a metrics batch for one turn-cost data point; separate from the
 * span pipeline since metrics don't flow through the BatchSpanProcessor. */
export async function writeTurnCostMetric(
  outputDir: string,
  metric: ReturnType<TurnCostMapper["toMetric"]>,
): Promise<void> {
  if (!metric) return;
  const resourceAttributes = buildResourceAttributes();
  await writeOtlpBatch(outputDir, "metrics", metricsDocument([metric], resourceAttributes));
}
