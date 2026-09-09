import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createLocaltraceService, PLUGIN_ID } from "./service.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OpenClaw Localtrace",
  description:
    "Full-fidelity OpenTelemetry capture for OpenClaw, written to your local filesystem only.",
  register(api) {
    api.registerService(createLocaltraceService());
  },
});
