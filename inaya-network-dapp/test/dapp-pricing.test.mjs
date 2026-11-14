// test/dapp-pricing.test.mjs
//
// The Dapp price book (src/lib/dappPricing.js) and the included monthly
// retrieval allowance for card customers (src/lib/egressAllowance.js).
// Uses a one-off test customer email; its rows are removed afterwards.
//
// Run with: node --env-file=.env.local --test test/dapp-pricing.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoClientPromise, { connectToDatabase } from "../src/lib/mongodb.js";
import {
  STORAGE_USDT_PER_TB_MONTH, UPLOAD_USDT_PER_GB, CORPORATE_RESERVE_TIERS, COMPETITOR_PRICES,
  NODE_SHARE_PERCENT, TREASURY_SHARE_PERCENT, TEAM_SHARE_PERCENT, competitorAnnualCost,
} from "../src/lib/dappPricing.js";
import { claimIncludedRetrieval, getAllowance, monthKey, ALLOWANCE_KIND } from "../src/lib/egressAllowance.js";

const EMAIL = `egress-test-${randomUUID()}@example.com`;
const OTHER = `egress-other-${randomUUID()}@example.com`;
const NOV = new Date("2026-11-13T10:00:00Z");
const DEC = new Date("2026-12-01T00:00:01Z");
let db;

const cleanup = async () => {
  for (const name of ["payg_assets", "egress_unlocks"]) {
    await db.collection(name).deleteMany({ email: { $in: [EMAIL, OTHER] } });
  }
};

before(async () => {
  ({ db } = await connectToDatabase());
  await cleanup();
  await db.collection("payg_assets").insertMany([
    { email: EMAIL, filename: "a.bin", fileHash: "0xaaa", sizeBytes: 600, stripeSessionId: `t-${randomUUID()}`, uploadedAt: 1 },
    { email: EMAIL, filename: "b.bin", fileHash: "0xbbb", sizeBytes: 400, stripeSessionId: `t-${randomUUID()}`, uploadedAt: 2 },
    { email: OTHER, filename: "c.bin", fileHash: "0xccc", sizeBytes: 5000, stripeSessionId: `t-${randomUUID()}`, uploadedAt: 3 },
  ]);
});
after(async () => { await cleanup(); await (await mongoClientPromise).close(); });

test("price book: the splits add up, tiers are consistent and Inaya is below every competitor's list price", () => {
  assert.equal(NODE_SHARE_PERCENT + TREASURY_SHARE_PERCENT + TEAM_SHARE_PERCENT, 100);
  assert.equal(UPLOAD_USDT_PER_GB * 1024, STORAGE_USDT_PER_TB_MONTH, "the upload fee is one month of storage");
  for (const [tier, t] of Object.entries(CORPORATE_RESERVE_TIERS)) {
    assert.equal(Math.round(t.tb * t.usdtPerTbMonth * 12), t.usdtPerYear, `${tier} annual fee = TB x rate x 12`);
    assert.ok(t.usdtPerTbMonth < STORAGE_USDT_PER_TB_MONTH, `${tier} is discounted off pay-as-you-go`);
    assert.ok(t.usdtPerYear < competitorAnnualCost(t.tb).b2, `${tier} is below Backblaze B2 for the same storage`);
  }
  for (const c of COMPETITOR_PRICES) assert.ok(STORAGE_USDT_PER_TB_MONTH < c.storagePerTb, `Inaya is below ${c.name}`);
  assert.deepEqual(competitorAnnualCost(250), { s3: 66600, b2: 20850 });
  assert.deepEqual(competitorAnnualCost(1000), { s3: 258600, b2: 83400 });
});

test("retrieval is included up to the stored volume each month, then refused", async () => {
  assert.equal(monthKey(NOV), "2026-11");
  assert.deepEqual(await getAllowance(db, EMAIL, NOV), { month: "2026-11", storedBytes: 1000, usedBytes: 0, remainingBytes: 1000 });

  const first = await claimIncludedRetrieval(db, EMAIL, "0xaaa", NOV);
  assert.equal(first.granted, true);
  assert.equal(first.remainingBytes, 400);

  const second = await claimIncludedRetrieval(db, EMAIL, "0xbbb", NOV);
  assert.equal(second.granted, true);
  assert.equal(second.remainingBytes, 0, "each file once = exactly the stored volume");

  const third = await claimIncludedRetrieval(db, EMAIL, "0xbbb", NOV);
  assert.equal(third.granted, false, "a repeat download beyond the stored volume is not included");
  assert.equal(third.reason, "allowance_used");
  assert.equal(third.usedBytes, 1000, "a refused claim uses nothing");

  const counter = await db.collection("egress_unlocks").findOne({ kind: ALLOWANCE_KIND, email: EMAIL, month: "2026-11" });
  assert.equal(counter.retrievals.length, 2, "only granted retrievals are logged");
  assert.equal(await db.collection("egress_unlocks").findOne({ email: EMAIL, fileHash: "0xaaa" }), null, "the counter is never mistaken for a paid unlock of a file");
});

test("a file that isn't the customer's is refused, and other customers are unaffected", async () => {
  const stranger = await claimIncludedRetrieval(db, EMAIL, "0xccc", NOV);
  assert.equal(stranger.granted, false);
  assert.equal(stranger.reason, "not_your_file");
  assert.equal((await getAllowance(db, OTHER, NOV)).usedBytes, 0);
});

test("the allowance resets with the calendar month", async () => {
  const next = await claimIncludedRetrieval(db, EMAIL, "0xaaa", DEC);
  assert.equal(next.granted, true);
  assert.equal(next.month, "2026-12");
  assert.equal(next.remainingBytes, 400);
});

test("two simultaneous claims cannot both take the last of the allowance", async () => {
  const results = await Promise.all([claimIncludedRetrieval(db, EMAIL, "0xbbb", DEC), claimIncludedRetrieval(db, EMAIL, "0xbbb", DEC)]);
  assert.equal(results.filter((r) => r.granted).length, 1);
  assert.equal((await getAllowance(db, EMAIL, DEC)).usedBytes, 1000);
});
