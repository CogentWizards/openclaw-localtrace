import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MUTATING_TOOL_NAMES, resolveConfig } from "../src/config.js";
import { defaultOverridePath } from "../src/pricing.js";

test("resolveConfig: everything defaults to the safe/off option when unset", () => {
  const config = resolveConfig(undefined, "/default/dir");
  assert.deepEqual(config, {
    enabled: false,
    outputDir: "/default/dir",
    captureContent: false,
    captureIdentifiers: false,
    maxOutputBytes: 500 * 1024 * 1024,
    maxAgeDays: 14,
    mutatingToolNames: DEFAULT_MUTATING_TOOL_NAMES,
    pricingTableOverridePath: defaultOverridePath,
  });
});

test("resolveConfig: pricingTableOverridePath can be overridden", () => {
  const config = resolveConfig({ pricingTableOverridePath: "/custom/path.json" }, "/default/dir");
  assert.equal(config.pricingTableOverridePath, "/custom/path.json");
});

test("resolveConfig: mutatingToolNames overrides the default list", () => {
  const config = resolveConfig({ mutatingToolNames: ["custom_write"] }, "/default/dir");
  assert.deepEqual(config.mutatingToolNames, ["custom_write"]);
});

test("resolveConfig: a non-string-array mutatingToolNames falls back to the default", () => {
  const config = resolveConfig({ mutatingToolNames: ["ok", 42] } as unknown as Record<string, unknown>, "/default/dir");
  assert.deepEqual(config.mutatingToolNames, DEFAULT_MUTATING_TOOL_NAMES);
});

test("resolveConfig: explicit values override defaults", () => {
  const config = resolveConfig(
    {
      enabled: true,
      outputDir: "/custom/dir",
      captureContent: true,
      captureIdentifiers: true,
      maxOutputBytes: 1000,
      maxAgeDays: 3,
    },
    "/default/dir",
  );
  assert.equal(config.enabled, true);
  assert.equal(config.outputDir, "/custom/dir");
  assert.equal(config.captureContent, true);
  assert.equal(config.captureIdentifiers, true);
  assert.equal(config.maxOutputBytes, 1000);
  assert.equal(config.maxAgeDays, 3);
});

test("resolveConfig: wrong-typed values fall back to defaults rather than propagating garbage", () => {
  const config = resolveConfig(
    { enabled: "yes", outputDir: 42, maxOutputBytes: "lots", maxAgeDays: -5 } as unknown as Record<
      string,
      unknown
    >,
    "/default/dir",
  );
  assert.equal(config.enabled, false);
  assert.equal(config.outputDir, "/default/dir");
  assert.equal(config.maxOutputBytes, 500 * 1024 * 1024);
  assert.equal(config.maxAgeDays, 14); // -5 is not > 0, so it doesn't count as a valid override
});

test("resolveConfig: empty-string outputDir does not override the default", () => {
  const config = resolveConfig({ outputDir: "" }, "/default/dir");
  assert.equal(config.outputDir, "/default/dir");
});
