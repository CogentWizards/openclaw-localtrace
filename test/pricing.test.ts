import assert from "node:assert/strict";
import test from "node:test";
import { createPricingResolver, estimateCostUsd, type PricingTable } from "../src/pricing.js";

test("estimateCostUsd: a known bare-key model (anthropic) computes input+output cost", () => {
  const cost = estimateCostUsd("anthropic", "claude-sonnet-5", { input: 1_000_000, output: 1_000_000 });
  assert.ok(cost !== undefined);
  assert.ok(cost! > 0);
});

test("estimateCostUsd: a known provider-prefixed-key model (gemini) still resolves", () => {
  const cost = estimateCostUsd("gemini", "gemini-2.5-flash", { input: 1_000_000, output: 0 });
  assert.ok(cost !== undefined);
});

test("estimateCostUsd: an unrecognized model returns undefined, never a guessed number", () => {
  const cost = estimateCostUsd("anthropic", "some-model-that-does-not-exist", { input: 100 });
  assert.equal(cost, undefined);
});

test("estimateCostUsd: an unrecognized provider returns undefined", () => {
  const cost = estimateCostUsd("some-unknown-provider", "claude-sonnet-5", { input: 100 });
  assert.equal(cost, undefined);
});

test("estimateCostUsd: missing provider/model/usage returns undefined", () => {
  assert.equal(estimateCostUsd(undefined, "claude-sonnet-5", { input: 1 }), undefined);
  assert.equal(estimateCostUsd("anthropic", undefined, { input: 1 }), undefined);
  assert.equal(estimateCostUsd("anthropic", "claude-sonnet-5", undefined), undefined);
});

test("estimateCostUsd: usage with no token fields at all returns undefined", () => {
  assert.equal(estimateCostUsd("anthropic", "claude-sonnet-5", {}), undefined);
});

test("estimateCostUsd: a provider alias (google -> gemini) resolves the same as the canonical name", () => {
  const viaAlias = estimateCostUsd("google", "gemini-2.5-flash", { input: 1000 });
  const viaCanonical = estimateCostUsd("gemini", "gemini-2.5-flash", { input: 1000 });
  assert.equal(viaAlias, viaCanonical);
  assert.ok(viaAlias !== undefined);
});

test("estimateCostUsd: cache tokens contribute when the model has cache pricing", () => {
  const withoutCache = estimateCostUsd("anthropic", "claude-sonnet-5", { input: 1000 })!;
  const withCache = estimateCostUsd("anthropic", "claude-sonnet-5", { input: 1000, cacheRead: 1000 })!;
  assert.ok(withCache > withoutCache);
});

// --- createPricingResolver: the override mechanism ---------------------

test("createPricingResolver: an override entry wins over the bundled price for the same provider/model", () => {
  const overrideTable: PricingTable = {
    "claude-sonnet-5": { provider: "anthropic", input: 1, output: 1, cacheRead: null, cacheWrite: null },
  };
  const resolver = createPricingResolver(overrideTable);
  const cost = resolver("anthropic", "claude-sonnet-5", { input: 10 });
  assert.equal(cost, 10); // 10 tokens * $1/token from the override, not the bundled rate
});

test("createPricingResolver: a model the override doesn't cover still resolves from the bundled table", () => {
  const overrideTable: PricingTable = {
    "some-other-model": { provider: "anthropic", input: 1, output: 1, cacheRead: null, cacheWrite: null },
  };
  const resolver = createPricingResolver(overrideTable);
  const cost = resolver("anthropic", "claude-sonnet-5", { input: 1_000_000 });
  assert.ok(cost !== undefined); // falls through to the bundled entry
  assert.notEqual(cost, 1_000_000); // not the override's $1/token rate
});

test("createPricingResolver: an empty override behaves identically to the bundled-only resolver", () => {
  const resolver = createPricingResolver({});
  const cost = resolver("anthropic", "claude-sonnet-5", { input: 1000, output: 500 });
  const bundledCost = estimateCostUsd("anthropic", "claude-sonnet-5", { input: 1000, output: 500 });
  assert.equal(cost, bundledCost);
});

test("estimateCostUsd: a real captured value is at least the right order of magnitude", () => {
  // From this plugin's own live-capture testing: claude-sonnet-5,
  // input=4, output=143 tokens produced a real openclaw.turn.cost.usd
  // of ~0.1022 (a whole-turn figure, not just this one call, so this
  // only checks the estimate is a sane positive number, not an exact
  // match).
  const cost = estimateCostUsd("anthropic", "claude-sonnet-5", { input: 4, output: 143 })!;
  assert.ok(cost > 0 && cost < 0.01);
});
