// test/referral-leaderboard.test.mjs
//
// Leaderboard ranking correctness, per the SOW: strictly by successful-
// referral count (successfulReferralCount, which is only ever incremented
// by the webhook's atomic crediting step — see referral-webhook-logic.js),
// zero-count referrers excluded, top 50 only.
//
// Tests getLeaderboardEntries() directly (src/lib/referrals.js) rather than
// the route.js wrapper — route.js only adds a NextResponse.json() call
// around it, and importing "next/server" fails to resolve under plain
// `node --test` (its package export map needs Next's own bundler; this
// isn't specific to this project). getLeaderboardEntries() carries 100% of
// the actual ranking behavior worth testing.
//
// Run with: node --test test/referral-leaderboard.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getReferralCollections, ensureReferralIndexes, getLeaderboardEntries } from "../src/lib/referrals.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-lb-${RUN_ID}-${label}@example.com`;

let collections;
const insertedIds = [];

before(async () => {
  await ensureReferralIndexes();
  collections = await getReferralCollections();

  const now = new Date().toISOString();
  const seed = [
    { label: "zero", count: 0 }, // must be excluded
    { label: "low", count: 3 },
    { label: "high", count: 42 },
    { label: "mid", count: 17 },
  ];
  for (const s of seed) {
    const insert = await collections.referrers.insertOne({
      email: email(s.label),
      status: "verified",
      successfulReferralCount: s.count,
      referralCode: `TESTLB${s.label.toUpperCase()}`.slice(0, 8),
      createdAt: now,
    });
    insertedIds.push(insert.insertedId);
  }
});

after(async () => {
  await collections.referrers.deleteMany({ _id: { $in: insertedIds } });
  const client = await mongoClientPromise;
  await client.close();
});

test("leaderboard: ranks strictly by successfulReferralCount descending and excludes zero-count referrers", async () => {
  const leaderboard = await getLeaderboardEntries(collections.referrers);

  const counts = leaderboard.map((r) => r.successfulReferralCount);
  const sorted = counts.every((c, i) => i === 0 || counts[i - 1] >= c);
  assert.ok(sorted, "leaderboard must be sorted descending by successfulReferralCount");

  const zeroCountPresent = leaderboard.some((r) => r.successfulReferralCount === 0);
  assert.equal(zeroCountPresent, false, "zero-count referrers must never appear on the leaderboard");

  const ranksAreSequential = leaderboard.every((r, i) => r.rank === i + 1);
  assert.ok(ranksAreSequential, "rank must be a plain 1-based sequential index");

  const highIdx = leaderboard.findIndex((r) => r.successfulReferralCount === 42);
  const midIdx = leaderboard.findIndex((r) => r.successfulReferralCount === 17);
  const lowIdx = leaderboard.findIndex((r) => r.successfulReferralCount === 3);
  assert.ok(highIdx !== -1 && midIdx !== -1 && lowIdx !== -1, "all three seeded non-zero referrers should appear");
  assert.ok(highIdx < midIdx && midIdx < lowIdx, "42 must rank above 17 must rank above 3");
});

test("leaderboard: masks referrer emails (no raw email addresses exposed)", async () => {
  const leaderboard = await getLeaderboardEntries(collections.referrers);
  for (const row of leaderboard) {
    assert.ok(row.email.includes("*"), `expected a masked email, got "${row.email}"`);
    assert.ok(!row.email.includes("test-lb"), "the masked email must not leak the un-redacted local part");
  }
});

test("leaderboard: caps at 50 entries", async () => {
  const now = new Date().toISOString();
  const extraIds = [];
  try {
    for (let i = 0; i < 55; i++) {
      const insert = await collections.referrers.insertOne({
        email: `test-lb-cap-${RUN_ID}-${i}@example.com`,
        status: "verified",
        successfulReferralCount: 1, // all tied, just need >50 qualifying rows
        referralCode: `C${String(i).padStart(3, "0")}${RUN_ID.slice(0, 4)}`, // 8 chars, unique per i
        createdAt: now,
      });
      extraIds.push(insert.insertedId);
    }
    const leaderboard = await getLeaderboardEntries(collections.referrers);
    assert.ok(leaderboard.length <= 50, `expected at most 50 rows, got ${leaderboard.length}`);
  } finally {
    await collections.referrers.deleteMany({ _id: { $in: extraIds } });
  }
});
