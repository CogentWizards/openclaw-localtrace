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

| OpenClaw internal event | Written as | Notes |
|---|---|---|
| `harness.run.*` | span `openclaw-localtrace.harness.run` | |
| `run.*` | span `openclaw-localtrace.run` | |
| `model.call.*` | span `openclaw-localtrace.model.call` | content gated by `captureContent` |
| `tool.execution.*` | span `openclaw-localtrace.tool.execution` | includes `openclaw.mutatingAction` — a real write/mutation signal, always unknown from the official exporter's output |
| `model.usage` | metric `openclaw.cost.usd` | cumulative, per (channel, provider, model) |

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
