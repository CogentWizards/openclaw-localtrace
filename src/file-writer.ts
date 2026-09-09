/**
 * Writes OTLP JSON documents to disk using the exact naming convention
 * `redundo collect` already uses (`traces-{unix_nanos}.otlp.json`, etc.)
 * -- this is what lets `redundo adapt <outputDir>` read this plugin's
 * output directly, with zero new parsing code on that side, and lets a
 * user mix this plugin's output with a `redundo collect`-captured
 * directory in the same folder.
 */

import { mkdir, writeFile } from "node:fs/promises";

export type OtlpSignal = "traces" | "logs" | "metrics";

// Date.now() is millisecond-resolution only in JS -- under a burst of
// writes within the same millisecond, a naive `${Date.now()}000000`
// filename would collide and silently overwrite a previous batch. Track
// the last value handed out and bump by 1ns whenever the clock hasn't
// visibly advanced, so every filename this process produces is guaranteed
// strictly increasing and unique, while still looking like (and mostly
// being) a real nanosecond epoch timestamp -- same convention `redundo
// collect` uses on the Python side (`time.time_ns()`), just without
// access to a true nanosecond-resolution wall clock in JS.
let lastNanos = 0n;

function nextUniqueNanos(): bigint {
  const candidate = BigInt(Date.now()) * 1_000_000n;
  const value = candidate > lastNanos ? candidate : lastNanos + 1n;
  lastNanos = value;
  return value;
}

export async function writeOtlpBatch(
  outputDir: string,
  signal: OtlpSignal,
  document: object,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const path = `${outputDir}/${signal}-${nextUniqueNanos().toString()}.otlp.json`;
  await writeFile(path, JSON.stringify(document), "utf-8");
  return path;
}
