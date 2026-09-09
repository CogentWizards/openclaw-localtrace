/**
 * A SpanExporter that writes directly to the local filesystem instead of
 * a network endpoint -- see the plan's "Local file output, not a network
 * exporter" section for why this is the central design decision of this
 * whole plugin, not an implementation detail.
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { writeOtlpBatch } from "./file-writer.js";
import { spanToOtlpJson, tracesDocument, type OtlpKeyValue } from "./otlp-json.js";

export class FileSpanExporter implements SpanExporter {
  private readonly outputDir: string;
  private readonly resourceAttributes: OtlpKeyValue[];

  constructor(outputDir: string, resourceAttributes: OtlpKeyValue[]) {
    this.outputDir = outputDir;
    this.resourceAttributes = resourceAttributes;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    const document = tracesDocument(spans.map(spanToOtlpJson), this.resourceAttributes);
    writeOtlpBatch(this.outputDir, "traces", document).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => resultCallback({ code: ExportResultCode.FAILED, error: error as Error }),
    );
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
