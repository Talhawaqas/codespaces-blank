// test/currency.test.mjs
//
// Business Workspace Remaining Features SOW — Multi-Currency Conversion.
// Pure logic, no DB needed.
//
// Run with: node --test test/currency.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, isSupportedCurrency, SUPPORTED_CURRENCIES } from "../src/lib/currency.js";

test("convert: same-currency is always exactly 1:1, no rounding drift", () => {
  const result = convert(1234.56, "USD", "USD");
  assert.deepEqual(result, { convertedAmount: 1234.56, rate: 1, ratesAsOf: result.ratesAsOf });
});

test("convert: a real cross-currency conversion uses the reference table, not a guess", () => {
  const result = convert(100, "USD", "EUR");
  assert.equal(result.convertedAmount, 92);
  assert.equal(result.rate, 0.92);
  assert.ok(result.ratesAsOf, "must always disclose which rate snapshot was used");
});

test("convert: an unsupported currency fails safely, never silently defaults to 1:1", () => {
  const result = convert(100, "USD", "JPY");
  assert.ok(result.error, "an unsupported target currency must return an explicit error, not a fabricated rate");
  assert.equal(result.convertedAmount, undefined);
});

test("convert: rejects a non-finite amount rather than propagating NaN", () => {
  const result = convert(NaN, "USD", "EUR");
  assert.ok(result.error);
});

test("isSupportedCurrency / SUPPORTED_CURRENCIES stay consistent", () => {
  for (const code of SUPPORTED_CURRENCIES) assert.equal(isSupportedCurrency(code), true);
  assert.equal(isSupportedCurrency("JPY"), false);
});
