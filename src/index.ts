/**
 * Registers hook handlers directly on the plugin api (api.on(...)),
 * alongside the service that owns the actual OTel/export lifecycle --
 * see runtime-handle.ts for why these are two separate seams, and
 * spans.ts's module docstring for why hooks replaced the earlier
 * ctx.internalDiagnostics design entirely.
 *
 * Two of these hooks are gate hooks whose host-side failure policy on a
 * thrown error is "fail closed" -- before_agent_run blocks the run,
 * before_tool_call blocks the tool call (see docs/plugins/hooks.md's
 * per-hook timeout/failure table). A bug in this plugin must never be
 * able to block real agent runs or tool calls, so every handler here is
 * wrapped in try/catch and always resolves to undefined (i.e. "pass" /
 * "no decision") no matter what happens inside.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createRuntimeHandle } from "./runtime-handle.js";
import { createLocaltraceService, PLUGIN_ID, writeTurnCostMetric } from "./service.js";
import type {
  AfterToolCallEvent,
  AgentContext,
  AgentEndEvent,
  BeforeAgentRunEvent,
  BeforeToolCallEvent,
  LlmInputEvent,
  LlmOutputEvent,
  ModelCallBaseEvent,
  ModelCallEndedEvent,
  ToolContext,
} from "./spans.js";
import type { ReplyPayloadSendingEvent } from "./metrics.js";

// Module-level, not created fresh inside register(): confirmed via live
// testing against a real Gateway that register(api) can be invoked more
// than once for this plugin within the same process (the exact trigger
// wasn't isolated, but the symptom was unambiguous -- see the commit this
// comment shipped in). A per-call `handle` left whichever registration's
// hooks were actually live pointing at a `handle` object nobody's service
// had populated: every hook fired correctly, but `handle.current` was
// always undefined, so no span or metric was ever written. A module-level
// singleton guarantees every register() call, and every hook closure it
// creates, shares the one handle whichever service instance actually
// starts writes into.
const handle = createRuntimeHandle();

function guarded(api: OpenClawPluginApi, label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    api.logger.warn(`openclaw-localtrace: ${label} handler failed: ${String(error)}`);
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OpenClaw Localtrace",
  description:
    "Full-fidelity OpenTelemetry capture for OpenClaw, written to your local filesystem only.",
  register(api) {
    api.registerService(createLocaltraceService(handle));

    api.on("before_agent_run", (event: BeforeAgentRunEvent, ctx: AgentContext) => {
      guarded(api, "before_agent_run", () => handle.current?.spanMapper.onBeforeAgentRun(event, ctx));
      return undefined; // always pass -- observation only, never gates the run
    });

    api.on("agent_end", (event: AgentEndEvent, ctx: AgentContext) => {
      guarded(api, "agent_end", () => handle.current?.spanMapper.onAgentEnd(event, ctx));
    });

    api.on("model_call_started", (event: ModelCallBaseEvent) => {
      guarded(api, "model_call_started", () => handle.current?.spanMapper.onModelCallStarted(event));
    });

    api.on("model_call_ended", (event: ModelCallEndedEvent) => {
      guarded(api, "model_call_ended", () => handle.current?.spanMapper.onModelCallEnded(event));
    });

    api.on("llm_input", (event: LlmInputEvent) => {
      guarded(api, "llm_input", () => handle.current?.spanMapper.onLlmInput(event));
    });

    api.on("llm_output", (event: LlmOutputEvent) => {
      guarded(api, "llm_output", () => handle.current?.spanMapper.onLlmOutput(event));
    });

    api.on("before_tool_call", (event: BeforeToolCallEvent, ctx: ToolContext) => {
      guarded(api, "before_tool_call", () => handle.current?.spanMapper.onBeforeToolCall(event, ctx));
      return undefined; // always pass -- observation only, never gates the tool call
    });

    api.on("after_tool_call", (event: AfterToolCallEvent, ctx: ToolContext) => {
      guarded(api, "after_tool_call", () => handle.current?.spanMapper.onAfterToolCall(event, ctx));
    });

    api.on("reply_payload_sending", (event: ReplyPayloadSendingEvent) => {
      guarded(api, "reply_payload_sending", () => {
        const runtime = handle.current;
        if (!runtime) return;
        const metric = runtime.turnCostMapper.toMetric(event);
        if (!metric) return;
        writeTurnCostMetric(runtime.outputDir, metric).catch((error: unknown) => {
          api.logger.warn(`openclaw-localtrace: failed to write turn-cost metric: ${String(error)}`);
        });
      });
      return undefined; // always no decision -- never rewrite or cancel the reply
    });
  },
});
