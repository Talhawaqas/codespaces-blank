// test/node-reputation.test.mjs
//
// Phase 5 (Node Telemetry & Reputation) coverage for the pure scoring
// function — no DB needed, this is deterministic math over timestamps.
//
// Run with: node --test test/node-reputation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUptimeScoreBps, HEARTBEAT_LOG_SIZE } from "../src/lib/nodeReputation.js";

const FIVE_MIN_MS = 5 * 60 * 1000;

function makeLog(count, gapMs, endTime) {
  const log = [];
  for (let i = 0; i < count; i++) log.push(new Date(endTime - (count - 1 - i) * gapMs).toISOString());
  return log;
}

test("a perfectly regular, currently-fresh node scores at or near 10000 bps", () => {
  const now = Date.now();
  const heartbeatLog = makeLog(10, FIVE_MIN_MS, now);
  const score = computeUptimeScoreBps({ heartbeatLog, lastHeartbeatAt: heartbeatLog.at(-1) }, now);
  assert.ok(score >= 9900, `expected ~10000, got ${score}`);
});

test("a node with no heartbeat history yet gets the benefit of the doubt on regularity, but still scored on staleness", () => {
  const now = Date.now();
  const score = computeUptimeScoreBps({ heartbeatLog: [], lastHeartbeatAt: new Date(now).toISOString() }, now);
  assert.ok(score >= 9000, `expected high score for a just-registered, fresh node, got ${score}`);
});

test("a node with no heartbeat at all scores 0", () => {
  const score = computeUptimeScoreBps({ heartbeatLog: [], lastHeartbeatAt: null });
  assert.equal(score, 0);
});

test("a node whose last heartbeat is very stale (well past the grace window) scores low even with a perfect past history", () => {
  const staleAt = Date.now() - FIVE_MIN_MS * 10; // 10 intervals ago, well past the 3x grace window
  const heartbeatLog = makeLog(10, FIVE_MIN_MS, staleAt);
  const score = computeUptimeScoreBps({ heartbeatLog, lastHeartbeatAt: staleAt }, Date.now());
  // regularity is still perfect (~10000), staleness is 0 -> averages to ~5000
  assert.ok(score >= 4500 && score <= 5500, `expected ~5000 (perfect regularity, zero staleness), got ${score}`);
});

test("a node with irregular gaps (missed beats) scores lower than a perfectly regular one", () => {
  const now = Date.now();
  const regularLog = makeLog(10, FIVE_MIN_MS, now);
  const irregularLog = makeLog(10, FIVE_MIN_MS * 2, now); // every beat took 2x as long as expected
  const regularScore = computeUptimeScoreBps({ heartbeatLog: regularLog, lastHeartbeatAt: regularLog.at(-1) }, now);
  const irregularScore = computeUptimeScoreBps({ heartbeatLog: irregularLog, lastHeartbeatAt: irregularLog.at(-1) }, now);
  assert.ok(irregularScore < regularScore, `expected irregular (${irregularScore}) < regular (${regularScore})`);
});

test("the heartbeat log cap constant is a small, bounded number (sanity check on the capped-array design)", () => {
  assert.ok(HEARTBEAT_LOG_SIZE > 0 && HEARTBEAT_LOG_SIZE <= 100);
});
