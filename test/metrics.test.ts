import assert from "node:assert/strict";
import test from "node:test";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { resolveConfig } from "../src/config.js";
import { UsageMetricMapper } from "../src/metrics.js";

type UsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }>;

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    type: "model.usage",
    ts: 1000,
    seq: 1,
    channel: "webchat",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: { total: 100 },
    costUsd: 0.5,
    ...overrides,
  } as UsageEvent;
}

test("UsageMetricMapper: event with no costUsd produces no metric", () => {
  const mapper = new UsageMetricMapper(resolveConfig(undefined, "/tmp/unused"));
  const metric = mapper.toMetric(usageEvent({ costUsd: undefined }));
  assert.equal(metric, undefined);
});

test("UsageMetricMapper: a single event produces one data point with matching start and observed time", () => {
  const mapper = new UsageMetricMapper(resolveConfig(undefined, "/tmp/unused"));
  const metric = mapper.toMetric(usageEvent({ ts: 5000, costUsd: 1.23 }));
  assert.ok(metric);
  assert.equal(metric.name, "openclaw.cost.usd");
  const point = metric.sum.dataPoints[0];
  assert.equal(point.startTimeUnixNano, "5000000000");
  assert.equal(point.timeUnixNano, "5000000000");
  assert.equal(point.asDouble, 1.23);
});

test("UsageMetricMapper: startTimeUnixNano stays fixed at first-seen for the same series across later events", () => {
  const mapper = new UsageMetricMapper(resolveConfig(undefined, "/tmp/unused"));
  const first = mapper.toMetric(usageEvent({ ts: 1000, costUsd: 0.1 }))!;
  const second = mapper.toMetric(usageEvent({ ts: 9000, costUsd: 0.4 }))!;
  assert.equal(first.sum.dataPoints[0].startTimeUnixNano, "1000000000");
  assert.equal(second.sum.dataPoints[0].startTimeUnixNano, "1000000000"); // unchanged
  assert.equal(second.sum.dataPoints[0].timeUnixNano, "9000000000"); // advances
});

test("UsageMetricMapper: different (channel, provider, model) combinations are independent series", () => {
  const mapper = new UsageMetricMapper(resolveConfig(undefined, "/tmp/unused"));
  const webchat = mapper.toMetric(usageEvent({ ts: 1000, channel: "webchat", costUsd: 0.1 }))!;
  const cron = mapper.toMetric(usageEvent({ ts: 5000, channel: "cron", costUsd: 0.2 }))!;
  assert.equal(webchat.sum.dataPoints[0].startTimeUnixNano, "1000000000");
  assert.equal(cron.sum.dataPoints[0].startTimeUnixNano, "5000000000"); // its own first-seen, not webchat's
});

test("UsageMetricMapper: sessionId is omitted unless captureIdentifiers is on", () => {
  const off = new UsageMetricMapper(resolveConfig({ captureIdentifiers: false }, "/tmp/unused"));
  const offMetric = off.toMetric(usageEvent({ sessionId: "s1" }))!;
  const offAttrs = offMetric.sum.dataPoints[0].attributes.map((a) => a.key);
  assert.ok(!offAttrs.includes("openclaw.sessionId"));

  const on = new UsageMetricMapper(resolveConfig({ captureIdentifiers: true }, "/tmp/unused"));
  const onMetric = on.toMetric(usageEvent({ sessionId: "s1" }))!;
  const onAttr = onMetric.sum.dataPoints[0].attributes.find((a) => a.key === "openclaw.sessionId");
  assert.equal(onAttr?.value.stringValue, "s1");
});
