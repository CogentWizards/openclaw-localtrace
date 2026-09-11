import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultOverridePath } from "../src/pricing.js";
import { parseArgs } from "../src/update-pricing-cli.js";

test("parseArgs: no arguments resolves to the default override path, not help", () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.help, false);
  assert.equal(parsed.outPath, defaultOverridePath);
});

test("parseArgs: --out <path> overrides the output path", () => {
  const parsed = parseArgs(["--out", "/tmp/custom-pricing-table.json"]);
  assert.equal(parsed.help, false);
  assert.equal(parsed.outPath, "/tmp/custom-pricing-table.json");
});

test("parseArgs: --out with no following value throws instead of silently using the default", () => {
  assert.throws(() => parseArgs(["--out"]), /--out requires a path argument/);
});

test("parseArgs: --help and -h both resolve to help mode, without requiring --out", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: an unrecognized flag throws rather than being silently ignored", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument: --bogus/);
});

test("parseArgs: a bare positional argument (no leading dash) also throws", () => {
  assert.throws(() => parseArgs(["nonsense"]), /unrecognized argument: nonsense/);
});

// Regression test for a real shipped bug (0.1.1/0.1.2): npm always wires a
// bin command up as a symlink (node_modules/.bin/<name> -> the real dist
// file -- exactly what `npx` and global installs run through), so
// process.argv[1] is the symlink path while import.meta.url resolves
// through it to the real file. The direct-invocation guard must account
// for that, or the CLI silently no-ops on every real install/npx
// invocation while still appearing to work when run by its own direct file
// path (the gap that let this ship unnoticed).
test("the built CLI actually runs (prints usage, doesn't silently no-op) when invoked through a bin-style symlink", () => {
  const builtCliPath = fileURLToPath(new URL("../src/update-pricing-cli.js", import.meta.url));
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-localtrace-cli-symlink-"));
  const symlinkPath = path.join(tmpDir, "openclaw-localtrace-update-pricing");
  symlinkSync(builtCliPath, symlinkPath);

  const output = execFileSync(process.execPath, [symlinkPath, "--help"], { encoding: "utf-8" });
  assert.match(output, /Usage: openclaw-localtrace-update-pricing/);
});
