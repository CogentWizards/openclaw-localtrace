/**
 * Maps OpenClaw's internal diagnostic events to real OTel spans, keeping
 * exactly the identifiers @openclaw/diagnostics-otel's DROPPED_OTEL_ATTRIBUTE_KEYS
 * deny-list removes -- sessionId, runId, callId, toolCallId -- gated
 * behind `captureIdentifiers` (off by default; see config.ts), plus
 * `mutatingAction` as a direct write signal no existing redundo source
 * has ever had access to.
 *
 * v1 scope is deliberately narrower than @openclaw/diagnostics-otel's own
 * (which maps ~45 event types for general Gateway observability): only
 * the four families redundo's Event schema actually needs become spans --
 * harness.run, run, model.call, tool.execution. Everything else is
 * uncounted in v1, a deliberate scope decision, not a limitation
 * inherited from the old exporter.
 *
 * Span hierarchy, inferred from the real correlation keys available (not
 * ambient/automatic context propagation -- diagnostic events arrive
 * async, addressed only by these ids): run (by runId) is outermost;
 * harness.run (same runId) nests under it; model.call/tool.execution
 * (same runId) nest under whichever of those two is currently open for
 * that runId, preferring the more specific harness.run. This mirrors
 * the existing Python-side adapter's own structural assumption
 * (sources/openclaw.py's _workflow_of walks up to the nearest
 * openclaw.harness.run ancestor) -- but is a first-cut heuristic, not
 * verified against live captured output yet. Expect to revisit once
 * this plugin actually runs against a real Gateway (see the plan's
 * safe-development-sequence checkpoint 4/5).
 */

import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { LocaltraceConfig } from "./config.js";
import { pruneUndefined } from "./utils.js";

const TRACER_NAME = "openclaw-localtrace";

class SpanTracker {
  private readonly byKey = new Map<string, Span>();

  start(key: string, span: Span): void {
    this.byKey.set(key, span);
  }

  /** Removes and returns the span, if one was tracked -- a span is ended at most once. */
  take(key: string): Span | undefined {
    const span = this.byKey.get(key);
    if (span !== undefined) this.byKey.delete(key);
    return span;
  }

  peek(key: string): Span | undefined {
    return this.byKey.get(key);
  }
}

function msToHrTimeInput(ms: number): number {
  return ms;
}

function parentContextFor(parent: Span | undefined) {
  if (!parent) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, parent.spanContext());
}

/** Handles the diagnostic-event stream for one plugin lifetime, tracking
 * in-flight spans and ending them as matching completion events arrive.
 */
export class SpanMapper {
  private readonly tracer;
  private readonly config: LocaltraceConfig;
  private readonly runSpans = new SpanTracker();
  private readonly harnessRunSpans = new SpanTracker();
  private readonly modelCallSpans = new SpanTracker();
  private readonly toolExecutionSpans = new SpanTracker();

  constructor(provider: BasicTracerProvider, config: LocaltraceConfig) {
    this.tracer = provider.getTracer(TRACER_NAME);
    this.config = config;
  }

  private parentFor(runId: string | undefined): Span | undefined {
    if (runId === undefined) return undefined;
    return this.harnessRunSpans.peek(runId) ?? this.runSpans.peek(runId);
  }

  private identifierAttrs(ids: Record<string, string | undefined>): Attributes {
    if (!this.config.captureIdentifiers) return {};
    return pruneUndefined(ids);
  }

  handle(event: DiagnosticEventPayload, _metadata: DiagnosticEventMetadata, privateData: DiagnosticEventPrivateData): void {
    switch (event.type) {
      case "run.started": {
        const span = this.tracer.startSpan(
          "openclaw-localtrace.run",
          {
            kind: SpanKind.INTERNAL,
            startTime: msToHrTimeInput(event.ts),
            attributes: pruneUndefined({
              "openclaw.provider": event.provider,
              "openclaw.model": event.model,
              "openclaw.channel": event.channel,
              "openclaw.trigger": event.trigger,
              ...this.identifierAttrs({ "openclaw.runId": event.runId, "openclaw.sessionId": event.sessionId }),
            }),
          },
          ROOT_CONTEXT,
        );
        this.runSpans.start(event.runId, span);
        return;
      }
      case "run.completed": {
        const span = this.runSpans.take(event.runId);
        if (!span) return;
        span.setAttribute("openclaw.outcome", event.outcome);
        if (event.errorCategory) span.setAttribute("openclaw.errorCategory", event.errorCategory);
        span.setStatus({ code: event.outcome === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        span.end(msToHrTimeInput(event.ts));
        return;
      }

      case "harness.run.started": {
        const parent = this.parentFor(event.runId);
        const span = this.tracer.startSpan(
          "openclaw-localtrace.harness.run",
          {
            kind: SpanKind.INTERNAL,
            startTime: msToHrTimeInput(event.ts),
            attributes: pruneUndefined({
              "openclaw.harnessId": event.harnessId,
              "openclaw.pluginId": event.pluginId,
              "openclaw.provider": event.provider,
              "openclaw.model": event.model,
              "openclaw.channel": event.channel,
              ...this.identifierAttrs({ "openclaw.runId": event.runId, "openclaw.sessionId": event.sessionId }),
            }),
          },
          parentContextFor(parent),
        );
        this.harnessRunSpans.start(event.runId, span);
        return;
      }
      case "harness.run.completed": {
        const span = this.harnessRunSpans.take(event.runId);
        if (!span) return;
        span.setAttribute("openclaw.outcome", event.outcome);
        if (event.resultClassification) span.setAttribute("openclaw.resultClassification", event.resultClassification);
        span.setStatus({ code: event.outcome === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        span.end(msToHrTimeInput(event.ts));
        return;
      }
      case "harness.run.error": {
        const span = this.harnessRunSpans.take(event.runId);
        if (!span) return;
        span.setAttribute("openclaw.errorCategory", event.errorCategory);
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.errorCategory });
        span.end(msToHrTimeInput(event.ts));
        return;
      }

      case "model.call.started": {
        const parent = this.parentFor(event.runId);
        const attributes: Attributes = pruneUndefined({
          "openclaw.provider": event.provider,
          "openclaw.model": event.model,
          "openclaw.api": event.api,
          "openclaw.transport": event.transport,
          ...this.identifierAttrs({
            "openclaw.runId": event.runId,
            "openclaw.sessionId": event.sessionId,
            "openclaw.callId": event.callId,
          }),
        });
        if (this.config.captureContent && privateData.modelContent) {
          if (privateData.modelContent.inputMessages !== undefined) {
            attributes["gen_ai.input.messages"] = JSON.stringify(privateData.modelContent.inputMessages);
          }
          if (privateData.modelContent.toolDefinitions !== undefined) {
            attributes["gen_ai.tool.definitions"] = JSON.stringify(privateData.modelContent.toolDefinitions);
          }
        }
        const span = this.tracer.startSpan(
          "openclaw-localtrace.model.call",
          { kind: SpanKind.CLIENT, startTime: msToHrTimeInput(event.ts), attributes },
          parentContextFor(parent),
        );
        this.modelCallSpans.start(event.callId, span);
        return;
      }
      case "model.call.completed": {
        const span = this.modelCallSpans.take(event.callId);
        if (!span) return;
        if (event.usage) {
          if (event.usage.input !== undefined) span.setAttribute("gen_ai.usage.input_tokens", event.usage.input);
          if (event.usage.output !== undefined) span.setAttribute("gen_ai.usage.output_tokens", event.usage.output);
          if (event.usage.cacheRead !== undefined) span.setAttribute("gen_ai.usage.cache_read.input_tokens", event.usage.cacheRead);
          if (event.usage.cacheWrite !== undefined) span.setAttribute("gen_ai.usage.cache_creation.input_tokens", event.usage.cacheWrite);
        }
        if (this.config.captureContent && privateData.modelContent?.outputMessages !== undefined) {
          span.setAttribute("gen_ai.output.messages", JSON.stringify(privateData.modelContent.outputMessages));
        }
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(msToHrTimeInput(event.ts));
        return;
      }
      case "model.call.error": {
        const span = this.modelCallSpans.take(event.callId);
        if (!span) return;
        span.setAttribute("openclaw.errorCategory", event.errorCategory);
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.errorCategory });
        span.end(msToHrTimeInput(event.ts));
        return;
      }

      case "tool.execution.started": {
        const parent = this.parentFor(event.runId);
        const attributes: Attributes = pruneUndefined({
          "openclaw.toolName": event.toolName,
          "openclaw.toolSource": event.toolSource,
          "openclaw.toolOwner": event.toolOwner,
          // The single most valuable capability unlock in this plugin: a
          // real write/mutation signal, always unknown from every other
          // redundo source. Never gated behind captureIdentifiers -- it's
          // a boolean classification, not an identifier.
          "openclaw.mutatingAction": event.mutatingAction,
          ...this.identifierAttrs({
            "openclaw.runId": event.runId,
            "openclaw.sessionId": event.sessionId,
            "openclaw.toolCallId": event.toolCallId,
          }),
        });
        if (this.config.captureContent && privateData.toolContent?.toolInput !== undefined) {
          attributes["gen_ai.tool.call.arguments"] = JSON.stringify(privateData.toolContent.toolInput);
        }
        const span = this.tracer.startSpan(
          "openclaw-localtrace.tool.execution",
          { kind: SpanKind.INTERNAL, startTime: msToHrTimeInput(event.ts), attributes },
          parentContextFor(parent),
        );
        if (event.toolCallId) this.toolExecutionSpans.start(event.toolCallId, span);
        else span.end(msToHrTimeInput(event.ts)); // no correlation id -- can't match a later completion, close now
        return;
      }
      case "tool.execution.completed": {
        const span = event.toolCallId ? this.toolExecutionSpans.take(event.toolCallId) : undefined;
        if (!span) return;
        if (this.config.captureContent && privateData.toolContent?.toolOutput !== undefined) {
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(privateData.toolContent.toolOutput));
        }
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(msToHrTimeInput(event.ts));
        return;
      }
      case "tool.execution.error": {
        const span = event.toolCallId ? this.toolExecutionSpans.take(event.toolCallId) : undefined;
        if (!span) return;
        span.setAttribute("openclaw.errorCategory", event.errorCategory);
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.errorCategory });
        span.end(msToHrTimeInput(event.ts));
        return;
      }
      case "tool.execution.blocked": {
        // A blocked call never executes, so there's no "started" span to
        // find and no "completed" to wait for -- the whole event is one
        // instant. Same discipline as sources/openclaw.py's own handling
        // of this case: surface it directly, the one place it can go.
        const parent = this.parentFor(event.runId);
        const span = this.tracer.startSpan(
          "openclaw-localtrace.tool.execution",
          {
            kind: SpanKind.INTERNAL,
            startTime: msToHrTimeInput(event.ts),
            attributes: pruneUndefined({
              "openclaw.toolName": event.toolName,
              "openclaw.outcome": "blocked",
              "openclaw.deniedReason": event.deniedReason,
              ...this.identifierAttrs({
                "openclaw.runId": event.runId,
                "openclaw.sessionId": event.sessionId,
                "openclaw.toolCallId": event.toolCallId,
              }),
            }),
          },
          parentContextFor(parent),
        );
        span.setStatus({ code: SpanStatusCode.ERROR, message: "blocked" });
        span.end(msToHrTimeInput(event.ts));
        return;
      }
      default:
        return; // out of v1 scope -- see module docstring
    }
  }
}
