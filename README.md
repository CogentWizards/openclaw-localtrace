# openclaw-localtrace

Full-fidelity OpenTelemetry capture for [OpenClaw](https://openclaw.ai),
written **only to your local filesystem** — no redaction, no network
export, no third-party backend.

## What you get

Real session IDs, a real write/mutation flag on every tool call, and a
per-call cost estimate — the exact things OpenClaw's own official
exporter, `@openclaw/diagnostics-otel`, deliberately strips before
exporting anything. This plugin exists to keep them, without adding any
network capability at all: there is no code path here that can send data
anywhere except a directory on your own machine.

```json
{ "name": "openclaw-localtrace.tool.execution", "attributes": {
    "openclaw.toolName": "apply_patch",
    "openclaw.mutatingAction": true,
    "openclaw.sessionId": "sess_abc123" } }
{ "name": "openclaw-localtrace.llm.call", "attributes": {
    "gen_ai.usage.input_tokens": 1200,
    "gen_ai.usage.cost_usd": 0.0058,
    "openclaw.pricingTableGeneratedAt": "2026-09-10T17:26:31.801Z" } }
```

(Real output from this plugin's own `SpanMapper`, not a mockup.) See
[docs/vs-diagnostics-otel.md](docs/vs-diagnostics-otel.md) for the full
comparison — this is not a drop-in replacement, and you can run both
plugins at once.

## Install

```bash
openclaw plugins install clawhub:@cogentwizards/openclaw-localtrace
openclaw plugins enable openclaw-localtrace
openclaw config set plugins.entries.openclaw-localtrace.config.enabled true
```

<details>
<summary>Installing from npm instead</summary>

```bash
openclaw plugins install @cogentwizards/openclaw-localtrace --force --accept-capabilities --acknowledge-install-policy-warning
openclaw plugins enable openclaw-localtrace
openclaw config set plugins.entries.openclaw-localtrace.config.enabled true
```

All three flags are required, not optional convenience — a bare
`openclaw plugins install @cogentwizards/openclaw-localtrace` fails twice
in a row, and the second failure leaves the plugin disabled with its
config wiped rather than rolling back cleanly:

- `--force` confirms installing from a source outside ClawHub's own
  review/trust metadata.
- `--accept-capabilities` consents to the real capabilities this plugin
  declares — it registers conversation-content hooks, gated separately
  behind `hooks.allowConversationAccess` below.
- `--acknowledge-install-policy-warning` acknowledges any
  `security.installPolicy` warning non-interactively; harmless to include
  even if your config has no such policy configured.

To install a specific version instead of `latest`, use
`@cogentwizards/openclaw-localtrace@<version>` in place of the bare
package name, and add `--pin` to record the exact resolved version rather
than a range.

</details>

(The npm *package* is scoped, `@cogentwizards/openclaw-localtrace` — but
the plugin's own `id`, used everywhere else here
(`plugins.entries.openclaw-localtrace.*`, `plugins enable
openclaw-localtrace`), stays unscoped. Two different namespaces that
happen to share a name.)

## Turn it on safely

Every capability beyond basic tool/model spans is an explicit,
off-by-default opt-in — read each one before enabling:

```bash
# Unlocks before_agent_run/agent_end/llm_input/llm_output. Without this,
# you still get model.call/tool.execution spans and turn-cost metrics --
# all three need no permission at all. Lives under `hooks`, a sibling of
# `config`, not inside it.
openclaw config set plugins.entries.openclaw-localtrace.hooks.allowConversationAccess true

# Include sessionId/runId/callId on spans and metrics. Off by default
# even though this is this plugin's whole reason to exist: a local file
# with real session identifiers is still real data at rest.
openclaw config set plugins.entries.openclaw-localtrace.config.captureIdentifiers true

# Include raw prompt/response/tool-argument/tool-result content. Off by
# default, same reasoning as @openclaw/diagnostics-otel's own captureContent.
openclaw config set plugins.entries.openclaw-localtrace.config.captureContent true
```

Restart the Gateway after changing config.

## Verify it worked

```bash
ls ~/.openclaw/openclaw-localtrace/traces/
```

Drive one real turn through the Gateway first if the directory is empty —
files land there within a few seconds (the OTel SDK batches writes; it's
not instant). Or check the plugin's own runtime status directly:

```bash
openclaw plugins inspect openclaw-localtrace --runtime --json
```

Look for `"status": "loaded"` and `"hookCount": 9`.

## What it captures

| Hook(s) | Written as | Notes |
|---|---|---|
| `before_agent_run` / `agent_end` | span `openclaw-localtrace.run` | requires `hooks.allowConversationAccess` |
| `model_call_started` / `model_call_ended` | span `openclaw-localtrace.model.call` | **no permission opt-in needed** — sanitized, no content |
| `llm_input` / `llm_output` | span `openclaw-localtrace.llm.call` | own span, not an enrichment of `model.call` — confirmed live that it brackets the *whole run* (opens before the first model call, closes after the last), not one individual call; content gated by `captureContent`, requires `hooks.allowConversationAccess`; token usage and the estimated `gen_ai.usage.cost_usd` below always attach once the hook fires |
| `before_tool_call` / `after_tool_call` | span `openclaw-localtrace.tool.execution` | **no permission opt-in needed**; includes `openclaw.mutatingAction`, a best-effort write/mutation classification from a configurable tool-name list (see `mutatingToolNames`) — there is no host-computed equivalent on this hook, unlike the old diagnostics-bus event |
| `reply_payload_sending` | metric `openclaw.turn.cost.usd` | **no permission opt-in needed**; one gauge point per turn, from `usageState.turnUsd` — only fires on live-dispatcher-delivered replies (confirmed against real usage: durable/recovered/replayed deliveries never carry it), so coverage is genuinely sparse |

See [docs/vs-diagnostics-otel.md](docs/vs-diagnostics-otel.md) for why
hooks, not the internal diagnostics bus `@openclaw/diagnostics-otel` uses.

Output files use the exact same naming convention (`traces-*.otlp.json`,
`logs-*.otlp.json`, `metrics-*.otlp.json`) and OTLP JSON shape that
`redundo collect` already writes, so [`redundo adapt
<outputDir>`](https://github.com/CogentWizards/redundo) reads this
plugin's output directly — no intermediate collector needed. Everything
here exists to feed a downstream analysis tool like `redundo`, not to be
a general Gateway-observability exporter.

## Cost estimates

`llm.call` spans carry `gen_ai.usage.cost_usd`, computed from that call's
own token usage against a bundled, static LiteLLM-derived pricing
snapshot — this plugin's own price list, a completely separate dataset
from whatever OpenClaw uses internally for its own cost estimates.

**A stale-but-present price is worse than a missing one** — a missing
model visibly produces no `cost_usd` at all; a provider quietly changing
a rate produces a confident, plausible-looking dollar figure that looks
exactly like a correct one. So every estimate also carries
`openclaw.pricingTableGeneratedAt` on the same span, always, and the
Gateway logs a warning at startup once the active pricing data is more
than 30 days old.

Refresh it without waiting for a new plugin release:

```bash
npx -p @cogentwizards/openclaw-localtrace openclaw-localtrace-update-pricing
```

(The `-p <package>` is required — the bin command's name doesn't match
the package name, so a bare `npx openclaw-localtrace-update-pricing`
404s looking for a package literally named that.) Writes to
`~/.openclaw/openclaw-localtrace/pricing-table.json` by default, which
the plugin checks automatically on every Gateway start — restart the
Gateway afterward. Pass `--out <path>` for a different location, together
with:

```bash
openclaw config set plugins.entries.openclaw-localtrace.config.pricingTableOverridePath "<path>"
```

See [docs/pricing.md](docs/pricing.md) for why this plugin maintains its
own catalog instead of reading OpenClaw's, and the repo-checkout refresh
path.

## More config

```bash
# Defaults to ~/.openclaw/openclaw-localtrace/traces/ if unset -- a
# dedicated subdir, kept separate from this plugin's own singleton files
# (e.g. pricing-table.json) that live one level up.
openclaw config set plugins.entries.openclaw-localtrace.config.outputDir "/path/you/choose"
openclaw config set plugins.entries.openclaw-localtrace.config.maxOutputBytes 524288000  # 500 MiB default
openclaw config set plugins.entries.openclaw-localtrace.config.maxAgeDays 14             # default

# Tool names classified as a write/mutation on the openclaw.mutatingAction
# span attribute. Defaults to a conservative built-in list (exec,
# apply_patch, write_file, edit_file, delete_file) -- override if your
# deployment adds custom tools with side effects.
openclaw config set plugins.entries.openclaw-localtrace.config.mutatingToolNames '["exec","apply_patch","my_custom_tool"]'
```

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
