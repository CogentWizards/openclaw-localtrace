/**
 * Plugin config lives under ctx.config.plugins.entries["openclaw-localtrace"].config
 * (confirmed against OpenClaw's own PluginEntryConfig type: `config?: Record<string, unknown>`),
 * NOT under any shared/core namespace like ctx.config.diagnostics.* --
 * coupling to a namespace another component owns is fragile, and this
 * plugin's whole point is to make different privacy defaults than that
 * namespace's owner (@openclaw/diagnostics-otel) chose, not inherit them.
 *
 * Every value here defaults to the safest option, read and validated by
 * hand rather than via a schema library -- this project has no other
 * dependency need heavy enough to justify one.
 */

export interface LocaltraceConfig {
  enabled: boolean;
  outputDir: string;
  captureContent: boolean;
  captureIdentifiers: boolean;
  maxOutputBytes: number;
  maxAgeDays: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 500 * 1024 * 1024; // 500 MiB
const DEFAULT_MAX_AGE_DAYS = 14;

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonEmptyString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function resolveConfig(
  raw: Record<string, unknown> | undefined,
  defaultOutputDir: string,
): LocaltraceConfig {
  const cfg = raw ?? {};
  return {
    enabled: readBoolean(cfg, "enabled", false),
    outputDir: readNonEmptyString(cfg, "outputDir", defaultOutputDir),
    captureContent: readBoolean(cfg, "captureContent", false),
    captureIdentifiers: readBoolean(cfg, "captureIdentifiers", false),
    maxOutputBytes: readPositiveNumber(cfg, "maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES),
    maxAgeDays: readPositiveNumber(cfg, "maxAgeDays", DEFAULT_MAX_AGE_DAYS),
  };
}
