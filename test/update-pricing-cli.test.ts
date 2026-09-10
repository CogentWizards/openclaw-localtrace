import assert from "node:assert/strict";
import test from "node:test";
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
