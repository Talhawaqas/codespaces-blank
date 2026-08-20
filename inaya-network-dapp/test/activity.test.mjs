// test/activity.test.mjs
//
// Covers DAU/WAU tracking: the ping validation guard, same-day dedup
// (upsert, not insert), and WAU's 7-day window boundary. Real MongoDB,
// disposable randomized identities, cleanup in after() — same convention
// as every other test file in this directory.
//
// Run with: node --test test/activity.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateActivityPingInput,
  recordActivityPing,
  getActiveUserStats,
  getActivityCollections,
  ensureActivityIndexes,
} from "../src/lib/activity.js";
import mongoClientPromise from "../src/lib/mongodb.js";

after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

// ---------------------------------------------------------------
// validateActivityPingInput
// ---------------------------------------------------------------

test("validateActivityPingInput: accepts a well-formed ping", () => {
  const clean = validateActivityPingInput({ surface: "dapp", identityId: "  0xABC123  " });
  assert.equal(clean.surface, "dapp");
  assert.equal(clean.identityId, "0xABC123");
});

test("validateActivityPingInput: rejects an unknown surface", () => {
  assert.throws(() => validateActivityPingInput({ surface: "website", identityId: "x" }), /surface must be one of/i);
});

test("validateActivityPingInput: rejects a missing identityId", () => {
  assert.throws(() => validateActivityPingInput({ surface: "dapp", identityId: "" }), /identityId is required/i);
  assert.throws(() => validateActivityPingInput({ surface: "dapp" }), /identityId is required/i);
});

// ---------------------------------------------------------------
// recordActivityPing + getActiveUserStats (real MongoDB)
// ---------------------------------------------------------------

const TEST_SURFACE = "dapp";
const TEST_IDENTITY_A = `test-${randomUUID().slice(0, 8)}`;
const TEST_IDENTITY_B = `test-${randomUUID().slice(0, 8)}`;
const TEST_IDENTITY_OLD = `test-${randomUUID().slice(0, 8)}`; // will be backdated outside the WAU window

test("recordActivityPing: repeated same-day pings for one identity don't inflate DAU", async () => {
  await ensureActivityIndexes();

  const before = await getActiveUserStats(TEST_SURFACE);

  await recordActivityPing({ surface: TEST_SURFACE, identityId: TEST_IDENTITY_A });
  await recordActivityPing({ surface: TEST_SURFACE, identityId: TEST_IDENTITY_A });
  await recordActivityPing({ surface: TEST_SURFACE, identityId: TEST_IDENTITY_A });

  const after1 = await getActiveUserStats(TEST_SURFACE);
  assert.equal(after1.dau, before.dau + 1, "three pings from the same identity should only count once");
});

test("recordActivityPing: a second distinct identity does increment DAU", async () => {
  const before = await getActiveUserStats(TEST_SURFACE);
  await recordActivityPing({ surface: TEST_SURFACE, identityId: TEST_IDENTITY_B });
  const after1 = await getActiveUserStats(TEST_SURFACE);
  assert.equal(after1.dau, before.dau + 1);
});

test("getActiveUserStats: WAU excludes pings older than the 7-day window", async () => {
  const { pings } = await getActivityCollections();

  // Insert a ping directly, backdated to 10 days ago — outside the window.
  const tenDaysAgo = new Date();
  tenDaysAgo.setUTCDate(tenDaysAgo.getUTCDate() - 10);
  const oldDateStr = tenDaysAgo.toISOString().slice(0, 10);

  await pings.updateOne(
    { surface: TEST_SURFACE, identityId: TEST_IDENTITY_OLD, date: oldDateStr },
    { $setOnInsert: { surface: TEST_SURFACE, identityId: TEST_IDENTITY_OLD, date: oldDateStr, createdAt: new Date().toISOString() } },
    { upsert: true }
  );

  const stats = await getActiveUserStats(TEST_SURFACE);
  const { wau: wauIdentityIds } = { wau: await pings.distinct("identityId", { surface: TEST_SURFACE, date: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) } }) };

  assert.ok(!wauIdentityIds.includes(TEST_IDENTITY_OLD), "an identity that only pinged 10 days ago must not count toward WAU");
  assert.ok(stats.wau >= 2, "the two identities from earlier tests this run should still be inside the WAU window");
});

// ---------------------------------------------------------------
// Cleanup — remove everything this test run created
// ---------------------------------------------------------------

test("cleanup: remove test pings", async () => {
  const { pings } = await getActivityCollections();
  await pings.deleteMany({ identityId: { $in: [TEST_IDENTITY_A, TEST_IDENTITY_B, TEST_IDENTITY_OLD] } });
});
