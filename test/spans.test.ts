import assert from "node:assert/strict";
import test from "node:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { resolveConfig } from "../src/config.js";
import { SpanMapper } from "../src/spans.js";

function harness(overrides: Partial<ReturnType<typeof resolveConfig>> = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const config = { ...resolveConfig(undefined, "/tmp/unused"), ...overrides };
  const mapper = new SpanMapper(provider, config);
  return { exporter, mapper };
}

function emptyMetadata() {
  return { trusted: true as const };
}

function emptyPrivateData() {
  return {};
}

test("SpanMapper: model.call.started + .completed produces one ended span", () => {
  const { exporter, mapper } = harness();
  mapper.handle(
    {
      type: "model.call.started",
      ts: 1000,
      seq: 1,
      runId: "run-1",
      callId: "call-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
    } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  assert.equal(exporter.getFinishedSpans().length, 0, "not ended yet");

  mapper.handle(
    {
      type: "model.call.completed",
      ts: 1500,
      seq: 2,
      runId: "run-1",
      callId: "call-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      durationMs: 500,
    } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "openclaw-localtrace.model.call");
  assert.equal(spans[0].attributes["openclaw.model"], "claude-sonnet-5");
});

test("SpanMapper: a completed event with no matching started is silently skipped, not fabricated", () => {
  const { exporter, mapper } = harness();
  mapper.handle(
    {
      type: "model.call.completed",
      ts: 1000,
      seq: 1,
      runId: "run-1",
      callId: "never-started",
      provider: "anthropic",
      model: "m",
    } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  assert.equal(exporter.getFinishedSpans().length, 0);
});

test("SpanMapper: identifiers are omitted unless captureIdentifiers is on", () => {
  const off = harness({ captureIdentifiers: false });
  off.mapper.handle(
    { type: "model.call.started", ts: 0, seq: 1, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  off.mapper.handle(
    { type: "model.call.completed", ts: 1, seq: 2, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  const offSpan = off.exporter.getFinishedSpans()[0];
  assert.equal(offSpan.attributes["openclaw.sessionId"], undefined);
  assert.equal(offSpan.attributes["openclaw.runId"], undefined);
  assert.equal(offSpan.attributes["openclaw.callId"], undefined);

  const on = harness({ captureIdentifiers: true });
  on.mapper.handle(
    { type: "model.call.started", ts: 0, seq: 1, runId: "r1", callId: "c1", sessionId: "s1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  on.mapper.handle(
    { type: "model.call.completed", ts: 1, seq: 2, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  const onSpan = on.exporter.getFinishedSpans()[0];
  assert.equal(onSpan.attributes["openclaw.sessionId"], "s1");
  assert.equal(onSpan.attributes["openclaw.runId"], "r1");
  assert.equal(onSpan.attributes["openclaw.callId"], "c1");
});

test("SpanMapper: model content is omitted unless captureContent is on", () => {
  const off = harness({ captureContent: false });
  off.mapper.handle(
    { type: "model.call.started", ts: 0, seq: 1, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    { modelContent: { inputMessages: [{ role: "user", content: "secret prompt" }] } },
  );
  off.mapper.handle(
    { type: "model.call.completed", ts: 1, seq: 2, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  const offSpan = off.exporter.getFinishedSpans()[0];
  assert.equal(offSpan.attributes["gen_ai.input.messages"], undefined);

  const on = harness({ captureContent: true });
  on.mapper.handle(
    { type: "model.call.started", ts: 0, seq: 1, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    { modelContent: { inputMessages: [{ role: "user", content: "hi" }] } },
  );
  on.mapper.handle(
    { type: "model.call.completed", ts: 1, seq: 2, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  const onSpan = on.exporter.getFinishedSpans()[0];
  assert.ok(typeof onSpan.attributes["gen_ai.input.messages"] === "string");
});

test("SpanMapper: mutatingAction is always kept, never gated behind captureIdentifiers", () => {
  const { exporter, mapper } = harness({ captureIdentifiers: false });
  mapper.handle(
    {
      type: "tool.execution.started",
      ts: 0,
      seq: 1,
      runId: "r1",
      toolCallId: "tc1",
      toolName: "exec",
      mutatingAction: true,
    } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  mapper.handle(
    { type: "tool.execution.completed", ts: 1, seq: 2, runId: "r1", toolCallId: "tc1", toolName: "exec", durationMs: 1 } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.attributes["openclaw.mutatingAction"], true);
});

test("SpanMapper: model.call nests under an open harness.run span for the same runId", () => {
  const { exporter, mapper } = harness();
  mapper.handle(
    { type: "harness.run.started", ts: 0, seq: 1, runId: "r1", harnessId: "openclaw" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  mapper.handle(
    { type: "model.call.started", ts: 1, seq: 2, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  mapper.handle(
    { type: "model.call.completed", ts: 2, seq: 3, runId: "r1", callId: "c1", provider: "p", model: "m" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  mapper.handle(
    { type: "harness.run.completed", ts: 3, seq: 4, runId: "r1", harnessId: "openclaw", durationMs: 3, outcome: "completed" } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );

  const spans = exporter.getFinishedSpans();
  const modelCallSpan = spans.find((s) => s.name === "openclaw-localtrace.model.call")!;
  const harnessRunSpan = spans.find((s) => s.name === "openclaw-localtrace.harness.run")!;
  assert.equal(modelCallSpan.parentSpanContext?.spanId, harnessRunSpan.spanContext().spanId);
});

test("SpanMapper: tool.execution.blocked is a single, complete instant span with no started/completed pair", () => {
  const { exporter, mapper } = harness();
  mapper.handle(
    {
      type: "tool.execution.blocked",
      ts: 5,
      seq: 1,
      runId: "r1",
      toolName: "exec",
      deniedReason: "policy",
      reason: "policy",
    } as DiagnosticEventPayload,
    emptyMetadata(),
    emptyPrivateData(),
  );
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].attributes["openclaw.outcome"], "blocked");
});

test("SpanMapper: an event type outside v1 scope is silently ignored, not an error", () => {
  const { exporter, mapper } = harness();
  assert.doesNotThrow(() => {
    mapper.handle(
      { type: "gateway.event_loop.sample", ts: 0, seq: 1, intervalMs: 1000, delayMaxMs: 1 } as DiagnosticEventPayload,
      emptyMetadata(),
      emptyPrivateData(),
    );
  });
  assert.equal(exporter.getFinishedSpans().length, 0);
});
