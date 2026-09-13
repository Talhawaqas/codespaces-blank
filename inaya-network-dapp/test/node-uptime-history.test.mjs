// test/node-uptime-history.test.mjs
//
// Node Operator Dashboard SOW — historical uptime aggregation and the
// 90-day/95% qualification tracker. Core correctness: insufficientData
// before any snapshot exists (the SOW's own "never fabricate a metric"
// principle), correct percentages once snapshots exist, and the streak
// advancing/resetting correctly across a below-threshold day.
//
// Run with: node --env-file=.env.local --test test/node-uptime-history.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getNodeHistoryCollections,
  getUptimeForWindow,
  isNodeOnline,
  classifyNodeHealth,
  advanceQualificationForNode,
  getQualificationStatus,
  QUALIFICATION_UPTIME_THRESHOLD_BPS,
} from "../src/lib/nodeUptimeHistory.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const wallet = (label) => `0xtest-${RUN_ID}-${label}`.toLowerCase();
const cleanup = { wallets: [] };

function trackWallet(w) {
  cleanup.wallets.push(w);
  return w;
}

async function insertSnapshot(walletAddress, takenAt, online, uptimeScoreBps = online ? 10000 : 0) {
  const { snapshots } = await getNodeHistoryCollections();
  await snapshots.insertOne({ walletAddress, takenAt, online, uptimeScoreBps, daemonVersion: "0.1.0" });
}

after(async () => {
  const { snapshots, events, qualification } = await getNodeHistoryCollections();
  await snapshots.deleteMany({ walletAddress: { $in: cleanup.wallets } });
  await events.deleteMany({ walletAddress: { $in: cleanup.wallets } });
  await qualification.deleteMany({ walletAddress: { $in: cleanup.wallets } });
  const client = await mongoClientPromise;
  await client.close();
});

test("isNodeOnline / classifyNodeHealth: the four SOW §6 states derive only from real telemetry", () => {
  const now = Date.now();
  assert.equal(classifyNodeHealth({ lastHeartbeatAt: null }, now), "unknown", "no heartbeat ever -> unknown, never 'healthy'");
  assert.equal(classifyNodeHealth({ lastHeartbeatAt: new Date(now - 20 * 60 * 1000).toISOString() }, now), "offline", "beyond the 15-minute timeout -> offline");
  assert.equal(classifyNodeHealth({ lastHeartbeatAt: new Date(now).toISOString(), uptimeScoreBps: 3000 }, now), "degraded", "online but a low combined score -> degraded");
  assert.equal(classifyNodeHealth({ lastHeartbeatAt: new Date(now).toISOString(), uptimeScoreBps: 9500 }, now), "healthy");
  assert.equal(isNodeOnline(null), false);
});

test("getUptimeForWindow: insufficientData is true before any snapshot has ever been recorded", async () => {
  const w = trackWallet(wallet("no-data"));
  const result = await getUptimeForWindow(w, "24h");
  assert.equal(result.insufficientData, true);
});

test("getUptimeForWindow: computes the correct percentage from real recorded snapshots", async () => {
  const w = trackWallet(wallet("basic"));
  const now = Date.now();
  // 4 online, 1 offline over the last 5 hours -> 80% uptime.
  for (let i = 4; i >= 1; i--) await insertSnapshot(w, new Date(now - i * 60 * 60 * 1000), true);
  await insertSnapshot(w, new Date(now), false);

  const result = await getUptimeForWindow(w, "24h");
  assert.equal(result.percentUptime, 80);
  assert.equal(result.outageCount, 1);
});

test("getUptimeForWindow: a window reaching further back than the earliest snapshot is flagged, not fabricated", async () => {
  const w = trackWallet(wallet("partial"));
  const now = Date.now();
  await insertSnapshot(w, new Date(now - 2 * 60 * 60 * 1000), true); // only 2 hours of real history
  await insertSnapshot(w, new Date(now), true);

  const result = await getUptimeForWindow(w, "30d"); // asking for 30 days, we only have ~2 hours
  assert.equal(result.insufficientData, true, "requesting a 30-day window with only 2h of data must be flagged");
  assert.equal(result.percentUptime, 100, "the covered portion is still reported, just flagged as partial");
});

test("qualification: a wallet with no qualification doc yet reports insufficient_data honestly", async () => {
  const w = trackWallet(wallet("qual-none"));
  const status = await getQualificationStatus(w);
  assert.equal(status.status, "insufficient_data");
  assert.equal(status.consecutiveQualifyingDays, 0);
});

test("qualification: a passing day advances the streak, and a below-threshold day resets it", async () => {
  const w = trackWallet(wallet("qual-streak"));
  const day1 = "2026-01-01";
  const day2 = "2026-01-02";
  const day3 = "2026-01-03";

  // Day 1: every hourly snapshot at 100% -> passes 95% threshold.
  for (let h = 0; h < 24; h++) {
    await insertSnapshot(w, new Date(`${day1}T${String(h).padStart(2, "0")}:00:00.000Z`), true, 10000);
  }
  await advanceQualificationForNode(w, day1);
  let status = await getQualificationStatus(w);
  assert.equal(status.status, "on_track");
  assert.equal(status.consecutiveQualifyingDays, 1);

  // Day 2: also passes -> streak advances to 2.
  for (let h = 0; h < 24; h++) {
    await insertSnapshot(w, new Date(`${day2}T${String(h).padStart(2, "0")}:00:00.000Z`), true, 10000);
  }
  await advanceQualificationForNode(w, day2);
  status = await getQualificationStatus(w);
  assert.equal(status.consecutiveQualifyingDays, 2);

  // Day 3: a bad day (0% uptime, well under the 95% threshold) -> streak resets to 0.
  for (let h = 0; h < 24; h++) {
    await insertSnapshot(w, new Date(`${day3}T${String(h).padStart(2, "0")}:00:00.000Z`), false, 0);
  }
  await advanceQualificationForNode(w, day3);
  status = await getQualificationStatus(w);
  assert.equal(status.consecutiveQualifyingDays, 0, "a day below the 95% threshold must reset the streak");
  assert.equal(status.status, "at_risk");
  assert.ok(status.lastResetReason, "a reset must record why");
});

test("qualification: a day with zero recorded snapshots moves nothing (no evidence, no guess)", async () => {
  const w = trackWallet(wallet("qual-noevidence"));
  const day1 = "2026-02-01";
  const emptyDay = "2026-02-02";

  for (let h = 0; h < 24; h++) {
    await insertSnapshot(w, new Date(`${day1}T${String(h).padStart(2, "0")}:00:00.000Z`), true, 10000);
  }
  await advanceQualificationForNode(w, day1);
  const before = await getQualificationStatus(w);
  assert.equal(before.consecutiveQualifyingDays, 1);

  await advanceQualificationForNode(w, emptyDay); // no snapshots exist for this day at all
  const after1 = await getQualificationStatus(w);
  assert.equal(after1.consecutiveQualifyingDays, 1, "a day with no telemetry must not advance OR reset the streak");
});

test("sanity: the qualification threshold is 95% expressed in basis points", () => {
  assert.equal(QUALIFICATION_UPTIME_THRESHOLD_BPS, 9500);
});
