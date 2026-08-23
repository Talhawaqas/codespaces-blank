// test/voteWeight.test.mjs
//
// Covers computeVoteWeight's pure logic against every InayaStaking lock tier.
// Run with: node --test test/voteWeight.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVoteWeight, FLEXIBLE_MULTIPLIER_BPS } from "../src/lib/voteWeight.js";

test("zero staked balance -> zero weight regardless of multiplier", () => {
  assert.equal(computeVoteWeight({ stakedBalance: 0n, lockMultiplierBps: 15000n }), 0n);
});

test("no lock ever set (lockMultiplierBps=0) defaults to the 1.00x flexible tier", () => {
  const staked = 1000n * 10n ** 18n;
  assert.equal(computeVoteWeight({ stakedBalance: staked, lockMultiplierBps: 0n }), staked);
  assert.equal(FLEXIBLE_MULTIPLIER_BPS, 10000n);
});

test("30-day tier applies the 1.25x multiplier", () => {
  const staked = 1000n * 10n ** 18n;
  const weight = computeVoteWeight({ stakedBalance: staked, lockMultiplierBps: 12500n });
  assert.equal(weight, (staked * 125n) / 100n);
});

test("90-day tier applies the 1.50x multiplier", () => {
  const staked = 1000n * 10n ** 18n;
  const weight = computeVoteWeight({ stakedBalance: staked, lockMultiplierBps: 15000n });
  assert.equal(weight, (staked * 15n) / 10n);
});

test("accepts plain number/string inputs, not just BigInt (Contract getter results coerce cleanly)", () => {
  const weight = computeVoteWeight({ stakedBalance: 500, lockMultiplierBps: 10000 });
  assert.equal(weight, 500n);
});
