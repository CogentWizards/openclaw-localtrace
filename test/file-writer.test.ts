import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeOtlpBatch } from "../src/file-writer.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "openclaw-localtrace-filewriter-test-"));
}

test("writeOtlpBatch: writes valid JSON matching the given document", async () => {
  const dir = await makeTempDir();
  const document = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }] };
  const filePath = await writeOtlpBatch(dir, "traces", document);
  const contents = JSON.parse(await readFile(filePath, "utf-8"));
  assert.deepEqual(contents, document);
});

test("writeOtlpBatch: file name matches redundo collect's own convention", async () => {
  const dir = await makeTempDir();
  const filePath = await writeOtlpBatch(dir, "metrics", {});
  assert.match(path.basename(filePath), /^metrics-\d+\.otlp\.json$/);
});

test("writeOtlpBatch: creates the output directory if it doesn't exist yet", async () => {
  const dir = path.join(await makeTempDir(), "nested", "deeper");
  await writeOtlpBatch(dir, "logs", {});
  const files = await readdir(dir);
  assert.equal(files.length, 1);
});

test("writeOtlpBatch: back-to-back writes in the same tick never collide", async () => {
  const dir = await makeTempDir();
  const paths = await Promise.all(
    Array.from({ length: 20 }, () => writeOtlpBatch(dir, "traces", {})),
  );
  assert.equal(new Set(paths).size, 20, "every path must be unique");
  const files = await readdir(dir);
  assert.equal(files.length, 20);
});
