# openclaw-localtrace

Full-fidelity OpenTelemetry capture for [OpenClaw](https://openclaw.ai),
written **only to your local filesystem** — no redaction, no network
export, no third-party backend.

## Why this exists, and how it's different from `@openclaw/diagnostics-otel`

OpenClaw's own official exporter, `@openclaw/diagnostics-otel`, deliberately
drops a specific set of identifiers before anything is exported —
`sessionId`, `runId`, `callId`, `chatId`, `messageId`, `toolCallId` — via a
literal deny-list applied to every span, log record, and security event it
produces. This is a real, considered decision, not an oversight: the
official docs state that exported spans carry "bounded identifiers...
rather than full IDs," and name the exporter's intended destinations as
third-party observability backends (Grafana, Datadog, Honeycomb, New
Relic) — vendors an operator may not fully control. Keeping identifiers
out by default means telemetry sent to one of those vendors can't be used
to correlate a specific trace back to a specific live conversation.

**This plugin exists because those exact identifiers are useful for local
analysis** — grouping repeated calls by real conversation, not just by
trace; distinguishing a tool call that mutated something from one that
didn't. Rather than disagree with the official exporter's tradeoff, this
plugin removes the one thing that made it necessary: it never has network
export capability at all. There is no code path in this plugin that can
send data anywhere except a directory on your own machine. If that
directory later gets copied somewhere else, that's a decision you make
explicitly — not a config value that silently ships session identifiers
to a SaaS vendor.

This is not a drop-in replacement for `@openclaw/diagnostics-otel` — the
two make different, deliberate tradeoffs. You can run both at once.

## What it captures

This plugin is built entirely on OpenClaw's typed **plugin hooks**
(`api.on(...)`), not the internal diagnostics bus `@openclaw/diagnostics-otel`
uses — that bus turned out to be gated behind a hardcoded check against
two literal service ids, unreachable by any third-party plugin regardless
of install method. Hooks are a real, documented, third-party-accessible
extension point instead: conversation-scoped hooks are unlocked per-plugin
by the plugin's own operator, in their own config — see Setup below.

| Hook(s) | Written as | Notes |
|---|---|---|
| `before_agent_run` / `agent_end` | span `openclaw-localtrace.run` | requires `hooks.allowConversationAccess` |
| `model_call_started` / `model_call_ended` | span `openclaw-localtrace.model.call` | **no permission opt-in needed** — sanitized, no content |
| `llm_input` / `llm_output` | span `openclaw-localtrace.llm.call` | own span, not an enrichment of `model.call` — confirmed live that it brackets the *whole run* (opens before the first model call, closes after the last), not one individual call; content gated by `captureContent`, requires `hooks.allowConversationAccess`; token usage and the estimated `gen_ai.usage.cost_usd` below always attach once the hook fires |
| `before_tool_call` / `after_tool_call` | span `openclaw-localtrace.tool.execution` | **no permission opt-in needed**; includes `openclaw.mutatingAction`, a best-effort write/mutation classification from a configurable tool-name list (see `mutatingToolNames`) — there is no host-computed equivalent on this hook, unlike the old diagnostics-bus event |
| `reply_payload_sending` | metric `openclaw.turn.cost.usd` | **no permission opt-in needed**; one gauge point per turn, from `usageState.turnUsd` — only fires on live-dispatcher-delivered replies (confirmed against real usage: durable/recovered/replayed deliveries never carry it), so coverage is genuinely sparse |

### Per-call cost estimate: `gen_ai.usage.cost_usd`

`openclaw.turn.cost.usd` above turned out to have real coverage gaps in
practice — it only fires for certain reply-delivery paths, so a live
capture can easily have real spend on a turn that never produces one.
`llm.call` spans additionally carry `gen_ai.usage.cost_usd`, computed
directly from that call's own token usage against a **bundled, static
pricing snapshot** (`src/pricing-table.json`, a curated subset of
[LiteLLM's public pricing data](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json)
for six major providers) — never a live network fetch, matching this
plugin's own "no code path reaches the network" design. It's a plain
provider-published-rate estimate: it doesn't know about your own
negotiated/discounted pricing, and it goes stale as new models ship —
an unrecognized model simply gets no cost estimate, never a guessed one.
Refresh it with `npm run update-pricing-table` (fetches a fresh copy of
LiteLLM's data, the only network access anywhere in this repo's own
tooling — the plugin itself still never does this at runtime), review
the diff, and commit it.

Everything else is out of scope for v1 — this plugin exists to feed
tools like [`redundo`](https://github.com/CogentWizards/redundo), not to
be a general Gateway-observability exporter.

Output files use the exact same naming convention (`traces-*.otlp.json`,
`logs-*.otlp.json`, `metrics-*.otlp.json`) and OTLP JSON shape that
`redundo collect` already writes, so `redundo adapt <outputDir>` reads
this plugin's output directly — no intermediate collector needed.

## Setup

```bash
openclaw plugins install <path-or-npm-spec>
openclaw plugins enable openclaw-localtrace
openclaw config set plugins.entries.openclaw-localtrace.config.enabled true
```

Grant this plugin access to conversation-scoped hooks (`before_agent_run`,
`agent_end`, `llm_input`, `llm_output`) — without this, only
`model.call`/`tool.execution` spans and turn-cost metrics are produced
(all three of those need no permission at all):

```bash
openclaw config set plugins.entries.openclaw-localtrace.hooks.allowConversationAccess true
```

Note this key lives under `hooks`, a sibling of `config` — not inside it.

Both of these are real, deliberate opt-ins — read before enabling:

```bash
# Include sessionId/runId/callId on spans and metrics. Off by default
# even though this is this plugin's whole reason to exist: a local file
# with real session identifiers is still real data at rest. Fine to
# enable once you understand where the output directory's contents will
# end up (nowhere, by default, but a decision worth making deliberately).
openclaw config set plugins.entries.openclaw-localtrace.config.captureIdentifiers true

# Include raw prompt/response/tool-argument/tool-result content. Off by
# default, same reasoning as @openclaw/diagnostics-otel's own captureContent.
openclaw config set plugins.entries.openclaw-localtrace.config.captureContent true
```

Optional:

```bash
openclaw config set plugins.entries.openclaw-localtrace.config.outputDir "/path/you/choose"
openclaw config set plugins.entries.openclaw-localtrace.config.maxOutputBytes 524288000  # 500 MiB default
openclaw config set plugins.entries.openclaw-localtrace.config.maxAgeDays 14             # default

# Tool names classified as a write/mutation on the openclaw.mutatingAction
# span attribute. Defaults to a conservative built-in list (exec,
# apply_patch, write_file, edit_file, delete_file) -- override if your
# deployment adds custom tools with side effects.
openclaw config set plugins.entries.openclaw-localtrace.config.mutatingToolNames '["exec","apply_patch","my_custom_tool"]'
```

Restart the Gateway after changing config.

## Local output retention

This plugin runs continuously in the background for as long as the
Gateway does, unlike a one-shot capture tool — unbounded local capture is
a real disk-exhaustion risk, not a hypothetical. A periodic sweep (hourly,
not on every write) deletes files older than `maxAgeDays` first, then
falls back to deleting the oldest remaining files if the directory is
still over `maxOutputBytes`. Nothing younger than 60 seconds is ever
touched, regardless of budget — defense in depth against a file that
might still be mid-write. Every sweep that actually deletes something logs
what and how much, via the Gateway's own logger — this plugin never
silently drops your capture history.

## Development

```bash
npm install
npm run build       # compiles src/ -> dist/ (this is what actually ships)
npm test            # compiles src/+test/ -> dist-test/, runs node --test against it
```

No live Gateway or network access is needed for the test suite — the
span-construction logic is tested against the real OTel SDK with an
in-memory exporter, and the retention sweep against real temp-directory
files with synthetic mtimes.

## License

MIT — see [LICENSE](LICENSE).
