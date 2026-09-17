# openclaw-localtrace

[![npm](https://img.shields.io/npm/v/%40cogentwizards%2Fopenclaw-localtrace.svg)](https://www.npmjs.com/package/@cogentwizards/openclaw-localtrace)
[![CI](https://github.com/CogentWizards/openclaw-localtrace/actions/workflows/ci.yml/badge.svg)](https://github.com/CogentWizards/openclaw-localtrace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full-fidelity OpenTelemetry capture for [OpenClaw](https://openclaw.ai) — written only to your local filesystem. No redaction, no network export, no third-party backend.

- **Real session IDs and a real write/mutation flag** on every tool call — exactly what OpenClaw's own official exporter (`@openclaw/diagnostics-otel`) strips out before exporting anything.
- **Nothing leaves your machine.** There is no code path here that can send data anywhere except a directory on disk.
- **A real per-call cost estimate**, from this plugin's own bundled pricing snapshot.

```json
{ "name": "openclaw-localtrace.tool.execution", "attributes": {
    "openclaw.toolName": "apply_patch",
    "openclaw.mutatingAction": true,
    "openclaw.sessionId": "sess_abc123" } }
```

(Real output from this plugin's own `SpanMapper`, not a mockup.) Full comparison with the official exporter: [docs/vs-diagnostics-otel.md](docs/vs-diagnostics-otel.md). Not a drop-in replacement — you can run both plugins at once.

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

All three flags are required, not optional convenience — a bare install
fails twice in a row and leaves the plugin disabled with its config
wiped rather than rolling back cleanly. `--force` confirms installing
from outside ClawHub's own trust metadata; `--accept-capabilities`
consents to the conversation-content hooks this plugin registers (gated
separately behind `hooks.allowConversationAccess` below);
`--acknowledge-install-policy-warning` acknowledges any
`security.installPolicy` warning non-interactively.

Pin a specific version with `@cogentwizards/openclaw-localtrace@<version>` and `--pin`.

</details>

## Turn it on

Every capability beyond basic tool/model spans is an explicit, off-by-default opt-in:

```bash
openclaw config set plugins.entries.openclaw-localtrace.hooks.allowConversationAccess true      # unlocks run/llm.call spans
openclaw config set plugins.entries.openclaw-localtrace.config.captureIdentifiers true           # real session/run/call ids
openclaw config set plugins.entries.openclaw-localtrace.config.captureContent true               # raw prompt/tool content
openclaw gateway restart
```

Verify it worked:

```bash
ls ~/.openclaw/openclaw-localtrace/traces/
openclaw plugins inspect openclaw-localtrace --runtime --json   # look for "status": "loaded"
```

## What it captures

| Hook(s) | Written as | Needs an opt-in? |
|---|---|---|
| `before_agent_run` / `agent_end` | span `openclaw-localtrace.run` | `allowConversationAccess` |
| `model_call_started` / `model_call_ended` | span `openclaw-localtrace.model.call` | no |
| `llm_input` / `llm_output` | span `openclaw-localtrace.llm.call` | content needs both opt-ins; token usage and cost always attach |
| `before_tool_call` / `after_tool_call` | span `openclaw-localtrace.tool.execution` | no |
| `reply_payload_sending` | metric `openclaw.turn.cost.usd` | no |

Feed the output straight to [`redundo`](https://github.com/CogentWizards/redundo) — same OTLP-JSON file format `redundo collect` writes, no collector needed:

```bash
redundo adapt "$(openclaw config get plugins.entries.openclaw-localtrace.config.outputDir)" \
  --summary | redundo analyze --format html > report.html
```

## Docs

- [docs/vs-diagnostics-otel.md](docs/vs-diagnostics-otel.md) — why this plugin exists, and why hooks instead of the internal diagnostics bus
- [docs/pricing.md](docs/pricing.md) — how cost estimates work, and how to refresh the bundled pricing table
- [docs/config.md](docs/config.md) — every config key, plus how local retention/cleanup works

## Development

```bash
npm install
npm run build       # compiles src/ -> dist/ (this is what actually ships)
npm test            # compiles src/+test/ -> dist-test/, runs node --test against it
```

No live Gateway or network access needed — the span-construction logic is tested against the real OTel SDK with an in-memory exporter.

## License

MIT — see [LICENSE](LICENSE).
