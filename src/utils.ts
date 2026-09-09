import type { Attributes } from "@opentelemetry/api";

/** Drops undefined/null values -- OTel's own Attributes type technically
 * allows them, but downstream OTLP JSON serialization shouldn't have to
 * special-case them, and most of these come straight from optional hook
 * event/context fields that are frequently absent. */
export function pruneUndefined(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}
