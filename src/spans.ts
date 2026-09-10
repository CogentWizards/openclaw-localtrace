/**
 * Maps OpenClaw's typed plugin *hooks* (api.on(...), registered in
 * register(api)) to real OTel spans -- this replaced an earlier design
 * built on ctx.internalDiagnostics, which turned out to be gated behind a
 * hardcoded check against exactly two literal service ids
 * ("diagnostics-otel", "diagnostics-prometheus"), unreachable by any
 * third-party plugin regardless of install method or trust level (see
 * the plan's "BLOCKED at checkpoint 4/5" section for how that was found
 * and confirmed live). The hook surface used here is a genuinely
 * different, documented, third-party-accessible permission model: a
 * conversation-access hook is unlocked per-plugin by the plugin's own
 * operator setting `plugins.entries.<id>.hooks.allowConversationAccess:
 * true` in their own openclaw.json -- confirmed clean by reading the
 * actual enforcement code (`resolveConversationAccessAllowed` in
 * hook-policy-decisions.ts): no catalog lookup, no literal plugin-id
 * check, just that one config key.
 *
 * The exact hook event/context shapes (PluginHookBeforeToolCallEvent,
 * PluginHookAfterToolCallEvent, PluginHookToolContext,
 * PluginHookAgentContext, PluginHookBeforeAgentRunEvent,
 * PluginHookAgentEndEvent, PluginHookModelCallStartedEvent,
 * PluginHookModelCallEndedEvent, PluginHookLlmInputEvent,
 * PluginHookLlmOutputEvent) are confirmed by direct inspection of
 * OpenClaw's compiled type declarations, but are NOT part of any
 * publicly exported `openclaw/plugin-sdk/*` subpath -- only
 * `OpenClawPluginApi` itself (whose `on` method references them
 * structurally) is exported. This module therefore declares its own
 * local, duck-typed interfaces matching the confirmed real shapes
 * (named *Event/*Context below) instead of importing them; TypeScript's
 * structural typing accepts the real, wider objects `api.on(...)` hands
 * back at each call site as long as the fields this module actually
 * reads line up, so this stays type-checked without a nominal import.
 *
 * v1 scope is deliberately narrower than @openclaw/diagnostics-otel's own
 * (~45 event types for general Gateway observability): five span
 * families, matching what redundo's Event schema needs -- run, model.call,
 * llm.call, tool.execution -- because that's what the hook catalog
 * actually offers; the diagnostics-bus design's separate "harness.run"
 * level does not have a hook analogue and is deliberately collapsed into
 * "run" here (before_agent_run opens it, agent_end closes it).
 *
 * Correlation keys, and why they differ per span family:
 * - run: keyed by `ctx.runId ?? "session:" + ctx.sessionKey` -- runId is
 *   optional on PluginHookAgentContext ("populated when OpenClaw can
 *   identify the active run"), so this falls back to sessionKey when
 *   absent. Verified live against a real Gateway (checkpoint 4/5):
 *   spans correctly nest under one run per turn.
 * - model.call: keyed by `callId` from model_call_started/ended, which
 *   is NOT gated behind allowConversationAccess at all (sanitized,
 *   no-content hooks) -- span open/close/timing/outcome therefore works
 *   even when the operator hasn't granted conversation access.
 * - llm.call: keyed by `runId` from llm_input/llm_output. **Originally
 *   designed to enrich the open model.call span for the same runId --
 *   confirmed WRONG by live testing.** llm_input fires *before*
 *   model_call_started, and llm_output fires *after* model_call_ended,
 *   bracketing a wider window rather than nesting inside model.call's
 *   own boundary. Since OTel spans reject attribute writes after
 *   `.end()`, there is no way to retroactively enrich an already-closed
 *   model.call span once llm_output arrives -- confirmed by a real
 *   traces file with the intended `gen_ai.*` attributes silently
 *   missing. Fixed by giving llm_input/llm_output their own independent
 *   span, a sibling of model.call under the same run, rather than
 *   trying to merge into it. Gated behind allowConversationAccess; if no
 *   open llm.call span exists for a runId when llm_output arrives
 *   (permission not granted, or an ordering surprise), the event is
 *   silently dropped rather than fabricating a span -- redundo's own
 *   "no confident wrong answer" discipline, applied here.
 * - tool.execution: keyed by `toolCallId` from before_tool_call/
 *   after_tool_call, neither of which needs any permission opt-in at
 *   all (confirmed: neither name is in the host's conversation-hook
 *   gate set).
 */

import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { LocaltraceConfig } from "./config.js";
import { estimateCostUsd, type PricingResolver } from "./pricing.js";
import { pruneUndefined } from "./utils.js";

const TRACER_NAME = "openclaw-localtrace";

// --- Local, duck-typed hook event/context shapes -- see module docstring. ---

export interface AgentContext {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  channel?: string;
}

export interface BeforeAgentRunEvent {
  prompt: string;
  accountId?: string;
  channelId?: string;
  senderId?: string;
}

export interface AgentEndEvent {
  runId?: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}

export interface ToolContext {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  toolCallId?: string;
}

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ModelCallBaseEvent {
  runId: string;
  callId: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  contextTokenBudget?: number;
}

export interface ModelCallEndedEvent extends ModelCallBaseEvent {
  durationMs: number;
  outcome: "completed" | "error";
  errorCategory?: string;
}

export interface LlmInputEvent {
  runId: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
}

export interface LlmOutputEvent {
  runId: string;
  provider?: string;
  model?: string;
  assistantTexts: string[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

// --- Span bookkeeping ---

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

function parentContextFor(parent: Span | undefined) {
  if (!parent) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, parent.spanContext());
}

function runKey(ctx: { runId?: string; sessionKey?: string }): string | undefined {
  if (ctx.runId !== undefined) return ctx.runId;
  if (ctx.sessionKey !== undefined) return `session:${ctx.sessionKey}`;
  return undefined;
}

/** Handles the hook-event stream for one plugin lifetime, tracking
 * in-flight spans and ending them as matching completion events arrive. */
export class SpanMapper {
  private readonly tracer;
  private readonly config: LocaltraceConfig;
  private readonly runSpans = new SpanTracker();
  private readonly modelCallSpans = new SpanTracker();
  /** Keyed by runId, not callId -- llm_input/llm_output carry no callId of
   * their own. Confirmed via live testing that these do NOT nest inside
   * model_call_started/ended's own boundary the way the module docstring
   * originally assumed: llm_input fires BEFORE model_call_started, and
   * llm_output fires AFTER model_call_ended -- i.e. they bracket a wider
   * window, not a narrower one nested inside it. Since OTel spans reject
   * attribute writes after .end(), there is no way to retroactively
   * enrich an already-closed model.call span once llm_output arrives.
   * This is therefore its own independent span, a sibling of model.call
   * under the same run, not an enrichment of it. */
  private readonly llmCallSpans = new SpanTracker();
  private readonly toolExecutionSpans = new SpanTracker();
  private readonly pricingResolver: PricingResolver;

  constructor(provider: BasicTracerProvider, config: LocaltraceConfig, pricingResolver: PricingResolver = estimateCostUsd) {
    this.tracer = provider.getTracer(TRACER_NAME);
    this.config = config;
    this.pricingResolver = pricingResolver;
  }

  private identifierAttrs(ids: Record<string, string | undefined>): Attributes {
    if (!this.config.captureIdentifiers) return {};
    return pruneUndefined(ids);
  }

  private mutatingAction(toolName: string): boolean {
    return this.config.mutatingToolNames.includes(toolName);
  }

  onBeforeAgentRun(event: BeforeAgentRunEvent, ctx: AgentContext): void {
    const key = runKey(ctx);
    if (key === undefined) return; // no correlation id at all -- can't track this run
    const span = this.tracer.startSpan(
      "openclaw-localtrace.run",
      {
        kind: SpanKind.INTERNAL,
        attributes: pruneUndefined({
          "openclaw.channel": ctx.channel,
          "openclaw.channelId": ctx.channelId ?? event.channelId,
          ...this.identifierAttrs({
            "openclaw.runId": ctx.runId,
            "openclaw.sessionId": ctx.sessionId,
          }),
        }),
      },
      ROOT_CONTEXT,
    );
    this.runSpans.start(key, span);
  }

  onAgentEnd(event: AgentEndEvent, ctx: AgentContext): void {
    const key = runKey(ctx) ?? (event.runId !== undefined ? event.runId : undefined);
    if (key === undefined) return;
    const span = this.runSpans.take(key);
    if (!span) return;
    span.setAttribute("openclaw.success", event.success);
    if (event.error) span.setAttribute("openclaw.error", event.error);
    span.setStatus({ code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end();
  }

  private parentForRun(ctx: { runId?: string; sessionKey?: string }): Span | undefined {
    const key = runKey(ctx);
    return key !== undefined ? this.runSpans.peek(key) : undefined;
  }

  onModelCallStarted(event: ModelCallBaseEvent): void {
    const parent = this.parentForRun({ runId: event.runId });
    const span = this.tracer.startSpan(
      "openclaw-localtrace.model.call",
      {
        kind: SpanKind.CLIENT,
        attributes: pruneUndefined({
          "openclaw.provider": event.provider,
          "openclaw.model": event.model,
          "openclaw.api": event.api,
          "openclaw.transport": event.transport,
          ...this.identifierAttrs({
            "openclaw.runId": event.runId,
            "openclaw.sessionId": event.sessionId,
            "openclaw.callId": event.callId,
          }),
        }),
      },
      parentContextFor(parent),
    );
    this.modelCallSpans.start(event.callId, span);
  }

  onModelCallEnded(event: ModelCallEndedEvent): void {
    const span = this.modelCallSpans.take(event.callId);
    if (!span) return;
    if (event.errorCategory) span.setAttribute("openclaw.errorCategory", event.errorCategory);
    span.setStatus({ code: event.outcome === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end();
  }

  onLlmInput(event: LlmInputEvent): void {
    const parent = this.parentForRun({ runId: event.runId });
    const attributes: Attributes = {};
    if (this.config.captureContent) {
      if (event.systemPrompt !== undefined) attributes["gen_ai.system_prompt"] = event.systemPrompt;
      attributes["gen_ai.input.messages"] = JSON.stringify([{ prompt: event.prompt, history: event.historyMessages }]);
    }
    const span = this.tracer.startSpan(
      "openclaw-localtrace.llm.call",
      { kind: SpanKind.CLIENT, attributes },
      parentContextFor(parent),
    );
    this.llmCallSpans.start(event.runId, span);
  }

  onLlmOutput(event: LlmOutputEvent): void {
    const span = this.llmCallSpans.take(event.runId);
    if (!span) return; // no open llm.call span for this run -- drop, don't fabricate
    if (event.usage) {
      if (event.usage.input !== undefined) span.setAttribute("gen_ai.usage.input_tokens", event.usage.input);
      if (event.usage.output !== undefined) span.setAttribute("gen_ai.usage.output_tokens", event.usage.output);
      if (event.usage.cacheRead !== undefined) span.setAttribute("gen_ai.usage.cache_read.input_tokens", event.usage.cacheRead);
      if (event.usage.cacheWrite !== undefined) span.setAttribute("gen_ai.usage.cache_creation.input_tokens", event.usage.cacheWrite);
      // Estimated, from a bundled static pricing snapshot -- see
      // pricing.ts's own module docstring for why this isn't a live
      // lookup. Not gated behind captureContent: like the token counts
      // above, this is derived data, not raw prompt/response content.
      const costUsd = this.pricingResolver(event.provider, event.model, event.usage);
      if (costUsd !== undefined) span.setAttribute("gen_ai.usage.cost_usd", costUsd);
    }
    if (this.config.captureContent) {
      span.setAttribute("gen_ai.output.messages", JSON.stringify(event.assistantTexts));
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }

  onBeforeToolCall(event: BeforeToolCallEvent, ctx: ToolContext): void {
    const attributes: Attributes = pruneUndefined({
      "openclaw.toolName": event.toolName,
      // A real host-computed write/mutation signal doesn't exist on this
      // hook (unlike the old diagnostics-bus event) -- see config.ts's
      // DEFAULT_MUTATING_TOOL_NAMES. Never gated behind captureIdentifiers:
      // it's a boolean classification, not an identifier.
      "openclaw.mutatingAction": this.mutatingAction(event.toolName),
      ...this.identifierAttrs({
        "openclaw.runId": ctx.runId ?? event.runId,
        "openclaw.sessionId": ctx.sessionId,
        "openclaw.toolCallId": ctx.toolCallId ?? event.toolCallId,
      }),
    });
    if (this.config.captureContent) {
      attributes["gen_ai.tool.call.arguments"] = JSON.stringify(event.params);
    }
    const parent = this.parentForRun({ runId: ctx.runId ?? event.runId, sessionKey: ctx.sessionKey });
    const span = this.tracer.startSpan(
      "openclaw-localtrace.tool.execution",
      { kind: SpanKind.INTERNAL, attributes },
      parentContextFor(parent),
    );
    const toolCallId = ctx.toolCallId ?? event.toolCallId;
    if (toolCallId) this.toolExecutionSpans.start(toolCallId, span);
    else span.end(); // no correlation id -- can't match a later completion, close now
  }

  onAfterToolCall(event: AfterToolCallEvent, ctx: ToolContext): void {
    const toolCallId = ctx.toolCallId ?? event.toolCallId;
    const span = toolCallId !== undefined ? this.toolExecutionSpans.take(toolCallId) : undefined;
    if (!span) return;
    if (event.error) {
      span.setAttribute("openclaw.error", event.error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
    } else {
      if (this.config.captureContent && event.result !== undefined) {
        span.setAttribute("gen_ai.tool.call.result", JSON.stringify(event.result));
      }
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }
}
