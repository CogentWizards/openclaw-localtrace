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
import { UsageMetricMapper } from "./metrics.js";
import { attributesToOtlp, metricsDocument, type OtlpKeyValue } from "./otlp-json.js";
import { sweepRetention } from "./retention.js";
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

function buildResourceAttributes(): OtlpKeyValue[] {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: PLUGIN_ID });
  return attributesToOtlp(resource.attributes);
}

export function createLocaltraceService(): OpenClawPluginService {
  let provider: BasicTracerProvider | undefined;
  let unsubscribe: (() => void) | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  return {
    id: PLUGIN_ID,
    reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}.config`] },

    async start(ctx: OpenClawPluginServiceContext) {
      const defaultOutputDir = path.join(ctx.stateDir, PLUGIN_ID);
      const config = resolveConfig(pluginConfig(ctx), defaultOutputDir);
      if (!config.enabled) return;

      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error("openclaw-localtrace: internal diagnostics capability unavailable");
        return;
      }

      const resourceAttributes = buildResourceAttributes();
      const exporter = new FileSpanExporter(config.outputDir, resourceAttributes);
      provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: PLUGIN_ID }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });

      const spanMapper = new SpanMapper(provider, config);
      const usageMetricMapper = new UsageMetricMapper(config);

      unsubscribe = subscribe((event, metadata, privateData) => {
        if (event.type === "model.usage") {
          const metric = usageMetricMapper.toMetric(event);
          if (metric) {
            writeOtlpBatch(config.outputDir, "metrics", metricsDocument([metric], resourceAttributes)).catch(
              (error: unknown) => {
                ctx.logger.warn(`openclaw-localtrace: failed to write metrics batch: ${String(error)}`);
              },
            );
          }
          return;
        }
        spanMapper.handle(event, metadata, privateData);
      });

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
      unsubscribe?.();
      unsubscribe = undefined;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
      if (provider) {
        await provider.shutdown(); // flushes the BatchSpanProcessor before actually stopping
        provider = undefined;
      }
    },
  };
}
