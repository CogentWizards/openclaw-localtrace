# Pricing data: this plugin's own catalog, not OpenClaw's

`gen_ai.usage.cost_usd` is computed from **this plugin's own**
bundled/fetched pricing snapshot. This is a completely separate,
unrelated dataset from whatever pricing catalog OpenClaw itself uses
internally for its own cost estimates elsewhere (its usage bar, `models`
commands, etc.).

We looked into reading OpenClaw's own resolved catalog directly instead
of maintaining a second one, and confirmed there's no way to. Its actual
computation lives in an internal, content-hashed module with no stable
import path. The public plugin-sdk surface only exposes helpers for
*submitting* pricing, not reading OpenClaw's resolved one. Nothing is
cached to disk, and neither `openclaw models list --json` nor `openclaw
models status --json` includes a single price field. This plugin's table
is the only option, not a fallback.

## Refreshing the bundled snapshot

The pricing snapshot (`src/pricing-table.json`, a curated subset of
[LiteLLM's public pricing data](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json)
for six major providers) is never fetched over the network at runtime.
This matches this plugin's own "no code path reaches the network"
design. It's a plain provider-published-rate estimate: it doesn't know
about your own negotiated/discounted pricing, and it goes stale as new
models ship. An unrecognized model simply gets no cost estimate, never a
guessed one.

**Repo-checkout path** (for the next published release):

```bash
npm run update-pricing-table
```

This fetches a fresh copy of LiteLLM's data, the only network access
anywhere in this repo's own tooling (the plugin itself still never does
this at runtime). Review the diff, and commit it.

**Published-package path**: see the README's Setup section for the
`npx -p @cogentwizards/openclaw-localtrace openclaw-localtrace-update-pricing`
command, which does the same fetch without a repo checkout or a new
release.

An override entry wins per provider/model. Anything it doesn't cover
still falls back to the bundled snapshot, so a small or slightly-stale
override never regresses coverage for everything else. A missing or
malformed override file is handled gracefully: silently ignored if
missing, since that's the normal default state, or logged as a warning
and ignored if present but unparseable. Either way, this never blocks the
plugin from starting.
