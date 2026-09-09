import assert from "node:assert/strict";
import test from "node:test";
import { attributesToOtlp, toAnyValue } from "../src/otlp-json.js";

test("toAnyValue: integer number becomes intValue as a string", () => {
  assert.deepEqual(toAnyValue(42), { intValue: "42" });
});

test("toAnyValue: fractional number becomes doubleValue", () => {
  assert.deepEqual(toAnyValue(1.5), { doubleValue: 1.5 });
});

test("toAnyValue: boolean becomes boolValue", () => {
  assert.deepEqual(toAnyValue(true), { boolValue: true });
});

test("toAnyValue: string becomes stringValue", () => {
  assert.deepEqual(toAnyValue("hello"), { stringValue: "hello" });
});

test("toAnyValue: array becomes a JSON-stringified stringValue", () => {
  assert.deepEqual(toAnyValue(["a", "b"]), { stringValue: '["a","b"]' });
});

test("attributesToOtlp: drops undefined values, keeps everything else", () => {
  const result = attributesToOtlp({ a: "x", b: undefined, c: 1 });
  assert.deepEqual(result, [
    { key: "a", value: { stringValue: "x" } },
    { key: "c", value: { intValue: "1" } },
  ]);
});
