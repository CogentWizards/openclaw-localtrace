import assert from "node:assert/strict";
import test from "node:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resolveConfig } from "../src/config.js";
import { SpanMapper } from "../src/spans.js";

function harness(overrides: Partial<ReturnType<typeof resolveConfig>> = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const config = { ...resolveConfig(undefined, "/tmp/unused"), ...overrides };
  const mapper = new SpanMapper(provider, config);
  return { exporter, mapper };
}

test("SpanMapper: model_call_started + model_call_ended produces one ended span", () => {
  const { exporter, mapper } = harness();
  mapper.onModelCallStarted({ runId: "run-1", callId: "call-1", provider: "anthropic", model: "claude-sonnet-5" });
  assert.equal(exporter.getFinishedSpans().length, 0, "not ended yet");

  mapper.onModelCallEnded({
    runId: "run-1",
    callId: "call-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    durationMs: 500,
    outcome: "completed",
  });

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "openclaw-localtrace.model.call");
  assert.equal(spans[0].attributes["openclaw.model"], "claude-sonnet-5");
});

test("SpanMapper: model_call_ended with no matching started is silently skipped, not fabricated", () => {
  const { exporter, mapper } = harness();
  mapper.onModelCallEnded({
    runId: "run-1",
    callId: "never-started",
    provider: "anthropic",
    model: "m",
    durationMs: 1,
    outcome: "completed",
  });
  assert.equal(exporter.getFinishedSpans().length, 0);
});

test("SpanMapper: identifiers are omitted unless captureIdentifiers is on", () => {
  const off = harness({ captureIdentifiers: false });
  off.mapper.onModelCallStarted({ runId: "r1", callId: "c1", provider: "p", model: "m" });
  off.mapper.onModelCallEnded({ runId: "r1", callId: "c1", provider: "p", model: "m", durationMs: 1, outcome: "completed" });
  const offSpan = off.exporter.getFinishedSpans()[0];
  assert.equal(offSpan.attributes["openclaw.sessionId"], undefined);
  assert.equal(offSpan.attributes["openclaw.runId"], undefined);
  assert.equal(offSpan.attributes["openclaw.callId"], undefined);

  const on = harness({ captureIdentifiers: true });
  on.mapper.onModelCallStarted({ runId: "r1", callId: "c1", sessionId: "s1", provider: "p", model: "m" });
  on.mapper.onModelCallEnded({ runId: "r1", callId: "c1", provider: "p", model: "m", durationMs: 1, outcome: "completed" });
  const onSpan = on.exporter.getFinishedSpans()[0];
  assert.equal(onSpan.attributes["openclaw.sessionId"], "s1");
  assert.equal(onSpan.attributes["openclaw.runId"], "r1");
  assert.equal(onSpan.attributes["openclaw.callId"], "c1");
});

test("SpanMapper: llm_input opens and llm_output closes its own llm.call span, independent of model.call's own boundary", () => {
  // Regression test for a real bug found via live testing: llm_input
  // fires BEFORE model_call_started and llm_output fires AFTER
  // model_call_ended, so they cannot enrich model.call's own span (OTel
  // rejects attribute writes after .end()). llm.call must be its own span.
  const { exporter, mapper } = harness({ captureContent: true });
  mapper.onLlmInput({ runId: "r1", prompt: "hi", historyMessages: [] });
  mapper.onModelCallStarted({ runId: "r1", callId: "c1", provider: "p", model: "m" });
  mapper.onModelCallEnded({ runId: "r1", callId: "c1", provider: "p", model: "m", durationMs: 1, outcome: "completed" });
  mapper.onLlmOutput({ runId: "r1", assistantTexts: ["hello"], usage: { input: 10, output: 20 } });

  const spans = exporter.getFinishedSpans();
  const modelCallSpan = spans.find((s) => s.name === "openclaw-localtrace.model.call")!;
  const llmCallSpan = spans.find((s) => s.name === "openclaw-localtrace.llm.call")!;
  assert.ok(modelCallSpan, "model.call span exists and closed normally, independent of llm.call");
  assert.ok(llmCallSpan, "llm.call span exists even though it opened before and closed after model.call");
  assert.ok(typeof llmCallSpan.attributes["gen_ai.input.messages"] === "string");
  assert.ok(typeof llmCallSpan.attributes["gen_ai.output.messages"] === "string");
  assert.equal(llmCallSpan.attributes["gen_ai.usage.input_tokens"], 10);
  assert.equal(llmCallSpan.attributes["gen_ai.usage.output_tokens"], 20);
});

test("SpanMapper: llm.call gets an estimated gen_ai.usage.cost_usd for a recognized provider/model, regardless of captureContent", () => {
  const { exporter, mapper } = harness({ captureContent: false });
  mapper.onLlmInput({ runId: "r1", prompt: "hi", historyMessages: [] });
  mapper.onLlmOutput({
    runId: "r1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    assistantTexts: ["hello"],
    usage: { input: 1000, output: 500 },
  });
  const span = exporter.getFinishedSpans()[0];
  const cost = span.attributes["gen_ai.usage.cost_usd"];
  assert.equal(typeof cost, "number");
  assert.ok((cost as number) > 0);
});

test("SpanMapper: llm.call has no cost_usd attribute for an unrecognized model", () => {
  const { exporter, mapper } = harness();
  mapper.onLlmInput({ runId: "r1", prompt: "hi", historyMessages: [] });
  mapper.onLlmOutput({
    runId: "r1",
    provider: "some-unknown-provider",
    model: "some-unknown-model",
    assistantTexts: ["hello"],
    usage: { input: 1000, output: 500 },
  });
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.attributes["gen_ai.usage.cost_usd"], undefined);
});

test("SpanMapper: llm.call content is omitted unless captureContent is on, usage tokens always attach", () => {
  const off = harness({ captureContent: false });
  off.mapper.onLlmInput({ runId: "r1", prompt: "secret prompt", historyMessages: [] });
  off.mapper.onLlmOutput({ runId: "r1", assistantTexts: ["secret reply"], usage: { input: 10, output: 20 } });
  const offSpan = off.exporter.getFinishedSpans()[0];
  assert.equal(offSpan.attributes["gen_ai.input.messages"], undefined);
  assert.equal(offSpan.attributes["gen_ai.output.messages"], undefined);
  assert.equal(offSpan.attributes["gen_ai.usage.input_tokens"], 10);
  assert.equal(offSpan.attributes["gen_ai.usage.output_tokens"], 20);

  const on = harness({ captureContent: true });
  on.mapper.onLlmInput({ runId: "r2", prompt: "hi", historyMessages: [] });
  on.mapper.onLlmOutput({ runId: "r2", assistantTexts: ["hello"] });
  const onSpan = on.exporter.getFinishedSpans()[0];
  assert.ok(typeof onSpan.attributes["gen_ai.input.messages"] === "string");
  assert.ok(typeof onSpan.attributes["gen_ai.output.messages"] === "string");
});

test("SpanMapper: llm_output with no open llm.call span for its run is dropped, not fabricated", () => {
  const { exporter, mapper } = harness({ captureContent: true });
  assert.doesNotThrow(() => {
    mapper.onLlmOutput({ runId: "no-such-run", assistantTexts: ["y"] });
  });
  assert.equal(exporter.getFinishedSpans().length, 0);
});

test("SpanMapper: llm.call nests under an open run span for the same runId", () => {
  const { exporter, mapper } = harness();
  mapper.onBeforeAgentRun({ prompt: "hi" }, { runId: "r1" });
  mapper.onLlmInput({ runId: "r1", prompt: "hi", historyMessages: [] });
  mapper.onLlmOutput({ runId: "r1", assistantTexts: ["hello"] });
  mapper.onAgentEnd({ success: true }, { runId: "r1" });

  const spans = exporter.getFinishedSpans();
  const runSpan = spans.find((s) => s.name === "openclaw-localtrace.run")!;
  const llmCallSpan = spans.find((s) => s.name === "openclaw-localtrace.llm.call")!;
  assert.equal(llmCallSpan.parentSpanContext?.spanId, runSpan.spanContext().spanId);
});

test("SpanMapper: before_tool_call/after_tool_call classifies mutatingAction from config, always kept regardless of captureIdentifiers", () => {
  const { exporter, mapper } = harness({ captureIdentifiers: false });
  mapper.onBeforeToolCall({ toolName: "exec", params: {}, runId: "r1" }, { toolCallId: "tc1" });
  mapper.onAfterToolCall({ toolName: "exec", params: {}, durationMs: 1 }, { toolCallId: "tc1" });
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.attributes["openclaw.mutatingAction"], true);
});

test("SpanMapper: a non-mutating tool is classified false", () => {
  const { exporter, mapper } = harness();
  mapper.onBeforeToolCall({ toolName: "web_search", params: {}, runId: "r1" }, { toolCallId: "tc1" });
  mapper.onAfterToolCall({ toolName: "web_search", params: {} }, { toolCallId: "tc1" });
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.attributes["openclaw.mutatingAction"], false);
});

test("SpanMapper: mutatingToolNames config override changes the classification", () => {
  const { exporter, mapper } = harness({ mutatingToolNames: ["custom_write"] });
  mapper.onBeforeToolCall({ toolName: "custom_write", params: {}, runId: "r1" }, { toolCallId: "tc1" });
  mapper.onAfterToolCall({ toolName: "custom_write", params: {} }, { toolCallId: "tc1" });
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.attributes["openclaw.mutatingAction"], true);
});

test("SpanMapper: model.call and tool.execution nest under an open run span for the same runId", () => {
  const { exporter, mapper } = harness();
  mapper.onBeforeAgentRun({ prompt: "hi" }, { runId: "r1" });
  mapper.onModelCallStarted({ runId: "r1", callId: "c1", provider: "p", model: "m" });
  mapper.onModelCallEnded({ runId: "r1", callId: "c1", provider: "p", model: "m", durationMs: 1, outcome: "completed" });
  mapper.onBeforeToolCall({ toolName: "exec", params: {}, runId: "r1" }, { toolCallId: "tc1", runId: "r1" });
  mapper.onAfterToolCall({ toolName: "exec", params: {} }, { toolCallId: "tc1" });
  mapper.onAgentEnd({ success: true }, { runId: "r1" });

  const spans = exporter.getFinishedSpans();
  const runSpan = spans.find((s) => s.name === "openclaw-localtrace.run")!;
  const modelCallSpan = spans.find((s) => s.name === "openclaw-localtrace.model.call")!;
  const toolSpan = spans.find((s) => s.name === "openclaw-localtrace.tool.execution")!;
  assert.equal(modelCallSpan.parentSpanContext?.spanId, runSpan.spanContext().spanId);
  assert.equal(toolSpan.parentSpanContext?.spanId, runSpan.spanContext().spanId);
});

test("SpanMapper: a before_tool_call with no toolCallId closes immediately as an instant span", () => {
  const { exporter, mapper } = harness();
  mapper.onBeforeToolCall({ toolName: "exec", params: {} }, {});
  assert.equal(exporter.getFinishedSpans().length, 1);
});

test("SpanMapper: agent_end with no matching run is silently skipped", () => {
  const { exporter, mapper } = harness();
  assert.doesNotThrow(() => {
    mapper.onAgentEnd({ success: true }, { runId: "never-started" });
  });
  assert.equal(exporter.getFinishedSpans().length, 0);
});

test("SpanMapper: run falls back to sessionKey when runId is absent", () => {
  const { exporter, mapper } = harness();
  mapper.onBeforeAgentRun({ prompt: "hi" }, { sessionKey: "sess-1" });
  mapper.onAgentEnd({ success: true }, { sessionKey: "sess-1" });
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "openclaw-localtrace.run");
});
