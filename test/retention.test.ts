import assert from "node:assert/strict";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sweepRetention } from "../src/retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "openclaw-localtrace-retention-test-"));
}

/** Writes a fake .otlp.json file and back-dates its mtime, so tests don't
 * depend on real elapsed time. */
async function writeAgedFile(dir: string, name: string, ageMs: number, size: number): Promise<void> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, "x".repeat(size));
  const mtime = new Date(Date.now() - ageMs);
  await utimes(filePath, mtime, mtime);
}

test("sweepRetention: leaves everything alone when under both budgets", async () => {
  const dir = await makeTempDir();
  await writeAgedFile(dir, "traces-1.otlp.json", DAY_MS, 100);
  const result = await sweepRetention(dir, 14, 10_000);
  assert.deepEqual(result, { deletedFiles: 0, deletedBytes: 0 });
  assert.deepEqual(await readdir(dir), ["traces-1.otlp.json"]);
});

test("sweepRetention: deletes files older than maxAgeDays", async () => {
  const dir = await makeTempDir();
  await writeAgedFile(dir, "old.otlp.json", 20 * DAY_MS, 100);
  await writeAgedFile(dir, "new.otlp.json", 1 * DAY_MS, 100);
  const result = await sweepRetention(dir, 14, 10_000);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.deletedBytes, 100);
  assert.deepEqual(await readdir(dir), ["new.otlp.json"]);
});

test("sweepRetention: falls back to size-based eviction, oldest first, once age sweep isn't enough", async () => {
  const dir = await makeTempDir();
  // All within maxAgeDays, so the age pass deletes nothing -- but the
  // total exceeds maxOutputBytes, so the oldest files must go first.
  await writeAgedFile(dir, "oldest.otlp.json", 5 * DAY_MS, 400);
  await writeAgedFile(dir, "middle.otlp.json", 3 * DAY_MS, 400);
  await writeAgedFile(dir, "newest.otlp.json", 1 * DAY_MS, 400);
  const result = await sweepRetention(dir, 14, 800);
  assert.equal(result.deletedFiles, 1);
  assert.deepEqual(await readdir(dir), ["middle.otlp.json", "newest.otlp.json"]);
});

test("sweepRetention: never deletes a file within the safety margin, even if it's technically over budget", async () => {
  const dir = await makeTempDir();
  // A single, very fresh file that alone exceeds maxOutputBytes -- must
  // survive regardless, since anything within the safety margin is
  // defense-in-depth against touching a file that might still be
  // mid-write.
  await writeAgedFile(dir, "fresh.otlp.json", 0, 1_000_000);
  const result = await sweepRetention(dir, 14, 100);
  assert.deepEqual(result, { deletedFiles: 0, deletedBytes: 0 });
  assert.deepEqual(await readdir(dir), ["fresh.otlp.json"]);
});

test("sweepRetention: age-based deletion also respects the safety margin", async () => {
  const dir = await makeTempDir();
  // "Older than maxAgeDays" by mtime math (maxAgeDays=0 here), but still
  // inside the 60s safety margin from `now` -- shouldn't happen with
  // real maxAgeDays values, but the guard should hold regardless of how
  // it's called.
  await writeAgedFile(dir, "edge.otlp.json", 0, 100);
  const result = await sweepRetention(dir, 0, 10_000);
  assert.deepEqual(result, { deletedFiles: 0, deletedBytes: 0 });
});

test("sweepRetention: ignores non-.otlp.json files entirely", async () => {
  const dir = await makeTempDir();
  await writeAgedFile(dir, "notes.txt", 30 * DAY_MS, 100);
  const result = await sweepRetention(dir, 14, 0);
  assert.deepEqual(result, { deletedFiles: 0, deletedBytes: 0 });
  assert.deepEqual(await readdir(dir), ["notes.txt"]);
});

test("sweepRetention: a missing output directory is not an error", async () => {
  const dir = path.join(tmpdir(), "openclaw-localtrace-does-not-exist-" + Date.now());
  const result = await sweepRetention(dir, 14, 10_000);
  assert.deepEqual(result, { deletedFiles: 0, deletedBytes: 0 });
});
