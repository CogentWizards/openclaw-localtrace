# Config reference

All config lives under `plugins.entries.openclaw-localtrace.config.*`
(and `hooks.allowConversationAccess`, a sibling of `config`, not inside
it — see the [README](../README.md) for the three main opt-ins).
Restart the Gateway after changing any of these.

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

# A local override path for the bundled pricing snapshot -- see docs/pricing.md.
openclaw config set plugins.entries.openclaw-localtrace.config.pricingTableOverridePath "<path>"
```

## Local output retention

This plugin runs continuously in the background for as long as the
Gateway does, unlike a one-shot capture tool. Unbounded local capture is
a real disk-exhaustion risk, not a hypothetical. A periodic sweep
(hourly, not on every write) deletes files older than `maxAgeDays`
first, then falls back to deleting the oldest remaining files if the
directory is still over `maxOutputBytes`. Nothing younger than 60
seconds is ever touched, regardless of budget, as defense in depth
against a file that might still be mid-write. Every sweep that actually
deletes something logs what and how much, via the Gateway's own logger.
This plugin never silently drops your capture history.
