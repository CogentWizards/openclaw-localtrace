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

import { defaultOverridePath } from "./pricing.js";

export interface LocaltraceConfig {
  enabled: boolean;
  outputDir: string;
  captureContent: boolean;
  captureIdentifiers: boolean;
  maxOutputBytes: number;
  maxAgeDays: number;
  mutatingToolNames: readonly string[];
  pricingTableOverridePath: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 500 * 1024 * 1024; // 500 MiB
const DEFAULT_MAX_AGE_DAYS = 14;

/**
 * The hook-based event surface (before_tool_call/after_tool_call) has no
 * host-computed write/mutation signal equivalent to the diagnostics bus's
 * `mutatingAction` field -- this list is our own best-effort substitute,
 * a conservative starting point covering OpenClaw's own built-in tools
 * with an obvious side effect. Overridable via config.mutatingToolNames
 * because this is a real, load-bearing classification (redundo's write
 * signal), not a cosmetic default -- a deployment with custom or
 * differently-named tools needs to be able to correct it rather than
 * silently misclassify every one of its own tool calls as non-mutating.
 */
export const DEFAULT_MUTATING_TOOL_NAMES: readonly string[] = [
  "exec",
  "apply_patch",
  "write_file",
  "edit_file",
  "delete_file",
];

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

function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  const value = raw[key];
  if (!Array.isArray(value) || value.length === 0) return fallback;
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : fallback;
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
    mutatingToolNames: readStringArray(cfg, "mutatingToolNames", DEFAULT_MUTATING_TOOL_NAMES),
    // Default doesn't depend on any per-call context (unlike
    // defaultOutputDir, which needs ctx.stateDir) -- see pricing.ts's own
    // docstring for why this fixed path is the plugin's own contract,
    // not a guess at some other component's directory convention.
    pricingTableOverridePath: readNonEmptyString(
      cfg,
      "pricingTableOverridePath",
      defaultOverridePath,
    ),
  };
}
