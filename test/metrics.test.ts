import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { TurnCostMapper, type ReplyPayloadSendingEvent } from "../src/metrics.js";

function replyEvent(overrides: Partial<ReplyPayloadSendingEvent> = {}): ReplyPayloadSendingEvent {
  return {
    sessionKey: "sess-1",
    usageState: {
      resolvedRef: "anthropic/claude-sonnet-5",
      sessionId: "s1",
      turnUsd: 0.5,
      usage: { input: 100, output: 50 },
    },
    ...overrides,
  };
}

test("TurnCostMapper: event with no usageState.turnUsd produces no metric", () => {
  const mapper = new TurnCostMapper(resolveConfig(undefined, "/tmp/unused"));
  const metric = mapper.toMetric(replyEvent({ usageState: { resolvedRef: "p/m" } }));
  assert.equal(metric, undefined);
});

test("TurnCostMapper: event with no usageState at all produces no metric", () => {
  const mapper = new TurnCostMapper(resolveConfig(undefined, "/tmp/unused"));
  const metric = mapper.toMetric(replyEvent({ usageState: undefined }));
  assert.equal(metric, undefined);
});

test("TurnCostMapper: a turn with cost produces one gauge data point", () => {
  const mapper = new TurnCostMapper(resolveConfig(undefined, "/tmp/unused"));
  const metric = mapper.toMetric(replyEvent({ usageState: { turnUsd: 1.23 } }), 5000);
  assert.ok(metric);
  assert.equal(metric.name, "openclaw.turn.cost.usd");
  const point = metric.gauge.dataPoints[0];
  assert.equal(point.startTimeUnixNano, "5000000000");
  assert.equal(point.timeUnixNano, "5000000000");
  assert.equal(point.asDouble, 1.23);
});

test("TurnCostMapper: sessionId/sessionKey are omitted unless captureIdentifiers is on", () => {
  const off = new TurnCostMapper(resolveConfig({ captureIdentifiers: false }, "/tmp/unused"));
  const offMetric = off.toMetric(replyEvent())!;
  const offAttrs = offMetric.gauge.dataPoints[0].attributes.map((a) => a.key);
  assert.ok(!offAttrs.includes("openclaw.sessionId"));
  assert.ok(!offAttrs.includes("openclaw.sessionKey"));

  const on = new TurnCostMapper(resolveConfig({ captureIdentifiers: true }, "/tmp/unused"));
  const onMetric = on.toMetric(replyEvent())!;
  const onAttr = onMetric.gauge.dataPoints[0].attributes.find((a) => a.key === "openclaw.sessionId");
  assert.equal(onAttr?.value.stringValue, "s1");
  const onSessionKeyAttr = onMetric.gauge.dataPoints[0].attributes.find((a) => a.key === "openclaw.sessionKey");
  assert.equal(onSessionKeyAttr?.value.stringValue, "sess-1");
});

test("TurnCostMapper: resolvedRef is kept regardless of captureIdentifiers", () => {
  const mapper = new TurnCostMapper(resolveConfig({ captureIdentifiers: false }, "/tmp/unused"));
  const metric = mapper.toMetric(replyEvent())!;
  const attr = metric.gauge.dataPoints[0].attributes.find((a) => a.key === "openclaw.resolvedRef");
  assert.equal(attr?.value.stringValue, "anthropic/claude-sonnet-5");
});
