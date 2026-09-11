# Why this exists, and how it differs from `@openclaw/diagnostics-otel`

OpenClaw's own official exporter, `@openclaw/diagnostics-otel`,
deliberately drops a specific set of identifiers before anything is
exported: `sessionId`, `runId`, `callId`, `chatId`, `messageId`,
`toolCallId`. It applies a literal deny-list to every span, log record,
and security event it produces. This is a real, considered decision, not
an oversight. The official docs state that exported spans carry "bounded
identifiers... rather than full IDs," and name the exporter's intended
destinations as third-party observability backends (Grafana, Datadog,
Honeycomb, New Relic), vendors an operator may not fully control. Keeping
identifiers out by default means telemetry sent to one of those vendors
can't be used to correlate a specific trace back to a specific live
conversation.

**This plugin exists because those exact identifiers are useful for local
analysis.** They let you group repeated calls by real conversation, not
just by trace, and distinguish a tool call that mutated something from
one that didn't. Rather than disagree with the official exporter's
tradeoff, this plugin removes the one thing that made it necessary: it
never has network export capability at all. There is no code path in
this plugin that can send data anywhere except a directory on your own
machine. If that directory later gets copied somewhere else, that's a
decision you make explicitly, not a config value that silently ships
session identifiers to a SaaS vendor.

This is not a drop-in replacement for `@openclaw/diagnostics-otel`. The
two make different, deliberate tradeoffs. You can run both at once.

## Why hooks, not the internal diagnostics bus

This plugin is built entirely on OpenClaw's typed **plugin hooks**
(`api.on(...)`), not the internal diagnostics bus
`@openclaw/diagnostics-otel` uses. The diagnostics bus turned out to be
gated behind a hardcoded check against two literal service ids
(`diagnostics-otel`, `diagnostics-prometheus`) combined with a
bundled-or-officially-trusted install check. It's unreachable by any
third-party plugin regardless of install method, confirmed by reading
OpenClaw's actual compiled runtime, not just its type definitions.

Hooks are a real, documented, third-party-accessible extension point
instead. Conversation-scoped hooks (`before_agent_run`, `agent_end`,
`llm_input`, `llm_output`) are unlocked per-plugin by the plugin's own
operator, in their own config (`hooks.allowConversationAccess`). That's
the same kind of explicit, operator-controlled opt-in as this plugin's
own `captureContent`/`captureIdentifiers` flags.
`before_tool_call`/`after_tool_call`/`model_call_started`/`model_call_ended`
need no permission opt-in at all.
