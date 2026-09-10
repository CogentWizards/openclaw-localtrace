import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conversationAccessWarning, hasConversationAccess, loadPricingResolver } from "../src/service.js";

function stubLogger() {
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    warnings,
    infos,
    logger: {
      warn: (msg: string) => warnings.push(msg),
      info: (msg: string) => infos.push(msg),
      error: () => {},
      debug: () => {},
    } as unknown as import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginServiceContext["logger"],
  };
}

test("loadPricingResolver: a missing override file resolves to the bundled-only resolver, silently", async () => {
  const { logger, warnings, infos } = stubLogger();
  const resolver = await loadPricingResolver("/no/such/path/pricing-table.json", logger);
  const cost = resolver("anthropic", "claude-sonnet-5", { input: 1000 });
  assert.ok(cost !== undefined); // bundled table still resolves it
  assert.equal(warnings.length, 0); // missing file is the normal default state, not worth a warning
  assert.equal(infos.length, 0);
});

test("loadPricingResolver: a valid override file is loaded and takes priority", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-localtrace-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const overridePath = path.join(dir, "pricing-table.json");
  await writeFile(
    overridePath,
    JSON.stringify({
      "claude-sonnet-5": { provider: "anthropic", input: 1, output: 1, cacheRead: null, cacheWrite: null },
    }),
    "utf-8",
  );

  const { logger, infos } = stubLogger();
  const resolver = await loadPricingResolver(overridePath, logger);
  const cost = resolver("anthropic", "claude-sonnet-5", { input: 10 });
  assert.equal(cost, 10); // the override's $1/token rate, not the bundled one
  assert.equal(infos.length, 1);
});

test("loadPricingResolver: a malformed override file warns and falls back to the bundled resolver", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-localtrace-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const overridePath = path.join(dir, "pricing-table.json");
  await writeFile(overridePath, "{not valid json", "utf-8");

  const { logger, warnings } = stubLogger();
  const resolver = await loadPricingResolver(overridePath, logger);
  const cost = resolver("anthropic", "claude-sonnet-5", { input: 1000 });
  assert.ok(cost !== undefined); // still falls back to the bundled table, not a crash
  assert.equal(warnings.length, 1);
});

// --- hasConversationAccess / conversationAccessWarning: the two-config-surface trap ---

test("hasConversationAccess: true only when explicitly set to true", () => {
  assert.equal(hasConversationAccess({ allowConversationAccess: true }), true);
  assert.equal(hasConversationAccess({ allowConversationAccess: false }), false);
  assert.equal(hasConversationAccess({}), false);
  assert.equal(hasConversationAccess(undefined), false);
  // A truthy-but-not-boolean value must not accidentally grant access --
  // this mirrors OpenClaw's own `=== true` check exactly, not `Boolean(x)`.
  assert.equal(hasConversationAccess({ allowConversationAccess: "true" }), false);
});

test("conversationAccessWarning: no warning when access is granted, regardless of capture config", () => {
  assert.equal(conversationAccessWarning(true, true, true), undefined);
  assert.equal(conversationAccessWarning(false, false, true), undefined);
});

test("conversationAccessWarning: no warning when neither capture option is on -- not a misconfiguration", () => {
  assert.equal(conversationAccessWarning(false, false, false), undefined);
});

test("conversationAccessWarning: warns when captureContent is on but access isn't granted", () => {
  const warning = conversationAccessWarning(true, false, false);
  assert.ok(warning);
  assert.match(warning, /config\.captureContent/);
  assert.match(warning, /hooks\.allowConversationAccess/);
  assert.doesNotMatch(warning, /config\.captureContent and/); // singular phrasing for one option
});

test("conversationAccessWarning: warns when captureIdentifiers is on but access isn't granted", () => {
  const warning = conversationAccessWarning(false, true, false);
  assert.ok(warning);
  assert.match(warning, /config\.captureIdentifiers/);
});

test("conversationAccessWarning: mentions both options by name when both are on", () => {
  const warning = conversationAccessWarning(true, true, false);
  assert.ok(warning);
  assert.match(warning, /config\.captureContent and config\.captureIdentifiers are on/);
});

test("conversationAccessWarning: includes the exact fix command", () => {
  const warning = conversationAccessWarning(true, false, false);
  assert.match(
    warning!,
    /openclaw config set plugins\.entries\.openclaw-localtrace\.hooks\.allowConversationAccess true/,
  );
});
