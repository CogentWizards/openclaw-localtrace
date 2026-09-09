/**
 * Hooks are registered once, unconditionally, in register(api) --
 * api.on(...) is a load-time registration call, not something that can
 * be deferred until a service's start(ctx) runs or skipped when the
 * plugin is disabled. The service (service.ts) still owns the actual
 * OTel provider/exporter/mapper lifecycle -- created on start() when
 * config.enabled is true, torn down on stop() or a config reload that
 * flips it off. This module is the seam between the two: hook handlers
 * (index.ts) read `handle.current` and no-op when it's undefined
 * (disabled, or not started yet); the service (service.ts) is the only
 * writer.
 */

import type { SpanMapper } from "./spans.js";
import type { TurnCostMapper } from "./metrics.js";

export interface LocaltraceRuntime {
  outputDir: string;
  spanMapper: SpanMapper;
  turnCostMapper: TurnCostMapper;
}

export interface RuntimeHandle {
  current: LocaltraceRuntime | undefined;
}

export function createRuntimeHandle(): RuntimeHandle {
  return { current: undefined };
}
