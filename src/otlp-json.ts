/**
 * Serialize OTel SDK spans/metric points directly to the OTLP JSON file
 * shape `redundo collect` already writes (traceId/spanId as lowercase hex
 * strings, startTimeUnixNano/endTimeUnixNano as decimal strings, attribute
 * values wrapped as {stringValue|intValue|doubleValue|boolValue}) -- so
 * `redundo.adapter.otlp`'s parsers need zero changes to read this plugin's
 * output. No protobuf encoding at all: there is no network exporter here,
 * so there's no wire format to speak, just a file format to match.
 */

import type { Attributes, AttributeValue, HrTime } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export function toAnyValue(value: AttributeValue | undefined): OtlpAnyValue {
  if (value === undefined) return { stringValue: "" };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    // OTLP JSON stringifies int64 to dodge JS float precision loss for
    // large values; a value with no fractional part is treated as an
    // int, matching redundo's own JSON number normalization convention
    // (hashing.py's _normalize_numbers) so round-tripping stays lossless.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { stringValue: JSON.stringify(value) };
  return { stringValue: String(value) };
}

export function attributesToOtlp(attributes: Attributes): OtlpKeyValue[] {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

function hrTimeToUnixNanoString(time: HrTime): string {
  const [seconds, nanos] = time;
  return (BigInt(seconds) * 1_000_000_000n + BigInt(nanos)).toString();
}

export interface OtlpSpanJson {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status?: { code: number };
}

/** OTLP StatusCode: 0 = UNSET, 1 = OK, 2 = ERROR -- same enum redundo's
 * otlp.py already reads from `status.code`. */
export function spanToOtlpJson(span: ReadableSpan): OtlpSpanJson {
  const context = span.spanContext();
  const json: OtlpSpanJson = {
    traceId: context.traceId,
    spanId: context.spanId,
    name: span.name,
    startTimeUnixNano: hrTimeToUnixNanoString(span.startTime),
    endTimeUnixNano: hrTimeToUnixNanoString(span.endTime),
    attributes: attributesToOtlp(span.attributes),
  };
  if (span.parentSpanContext?.spanId) {
    json.parentSpanId = span.parentSpanContext.spanId;
  }
  if (span.status && span.status.code !== 0) {
    json.status = { code: span.status.code };
  }
  return json;
}

export function tracesDocument(
  spans: OtlpSpanJson[],
  resourceAttributes: OtlpKeyValue[],
): object {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

export interface OtlpMetricPointJson {
  startTimeUnixNano: string;
  timeUnixNano: string;
  asDouble?: number;
  asInt?: string;
  attributes: OtlpKeyValue[];
}

export interface OtlpSumMetricJson {
  name: string;
  description: string;
  unit: string;
  sum: {
    dataPoints: OtlpMetricPointJson[];
    aggregationTemporality: number; // 2 = CUMULATIVE, matching openclaw.cost.usd's own shape
    isMonotonic: boolean;
  };
}

/** A point-in-time, non-cumulative measurement -- e.g. one turn's
 * estimated cost, which isn't additive across data points the way a
 * running total is. The technically-correct OTLP shape for that is
 * Gauge, not (non-monotonic) Sum. */
export interface OtlpGaugeMetricJson {
  name: string;
  description: string;
  unit: string;
  gauge: {
    dataPoints: OtlpMetricPointJson[];
  };
}

export type OtlpMetricJson = OtlpSumMetricJson | OtlpGaugeMetricJson;

export function metricsDocument(
  metrics: OtlpMetricJson[],
  resourceAttributes: OtlpKeyValue[],
): object {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes },
        scopeMetrics: [{ metrics }],
      },
    ],
  };
}
