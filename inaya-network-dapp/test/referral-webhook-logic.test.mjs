// test/referral-webhook-logic.test.mjs
//
// Fraud-prevention tests for the referral program, per the SOW's explicit
// verification requirements: self-referral, duplicate webhook firing, and
// cap enforcement. Runs against the REAL configured MongoDB (no test-DB
// override exists in this project) using randomly-suffixed test emails so
// runs don't collide, with full cleanup in `after()`.
//
// The one exception is program_counters: that's a singleton "global" doc
// shared with production data, so these tests never touch it directly.
// Cap-enforcement is instead verified against atomicCappedIncrement()
// (src/lib/referrals.js) using a disposable, uniquely-named test document
// in the same collection — that's the exact mechanism (and the exact spot
// a real bug was caught and fixed during development: upsert:true combined
// with a non-equality filter throws a duplicate-key error instead of
// cleanly returning null once the doc exists but fails the cap check).
//
// Run with: node --test test/referral-webhook-logic.test.mjs
// Requires MONGODB_URI to be set (e.g. `set -a && source .env.local && set +a`).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getReferralCollections,
  ensureReferralIndexes,
  atomicCappedIncrement,
  computeIdentityFingerprint,
  MAX_REFERRALS_PER_REFERRER,
} from "../src/lib/referrals.js";
import { handleActivationDecision, handleReferralDecision } from "../src/lib/referral-webhook-logic.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-${RUN_ID}-${label}@example.com`;

function fakeDecision({ status = "Approved", documentNumber, issuingState = "US" }) {
  return {
    status,
    session_id: `fake-session-${randomUUID()}`,
    id_verifications: documentNumber ? [{ document_number: documentNumber, issuing_state: issuingState, full_name: "Test Person" }] : [],
  };
}

let collections;
const createdIds = { referrers: [], referrals: [] };

before(async () => {
  await ensureReferralIndexes();
  collections = await getReferralCollections();
});

after(async () => {
  // Full cleanup — delete only what this run created, by email/_id, and
  // never touch the shared "global" program_counters doc.
  await collections.referrers.deleteMany({ _id: { $in: createdIds.referrers } });
  await collections.referrals.deleteMany({ _id: { $in: createdIds.referrals } });
  await collections.kycIdentities.deleteMany({ email: { $regex: `^test-${RUN_ID}-` } });
  await collections.referralRewards.deleteMany({ user: { $regex: `^test-${RUN_ID}-` } });
  await collections.programCounters.deleteMany({ _id: { $regex: `^test-cap-${RUN_ID}-` } });
  // Without this, node --test hangs indefinitely after the last test — the
  // shared MongoClient (src/lib/mongodb.js) keeps its socket open by design
  // for reuse across serverless invocations, which is exactly wrong for a
  // one-shot test process.
  const client = await mongoClientPromise;
  await client.close();
});

async function makeVerifiedReferrer(label, { documentNumber }) {
  const now = new Date().toISOString();
  const referrerEmail = email(label);
  const insert = await collections.referrers.insertOne({
    email: referrerEmail,
    status: "pending",
    successfulReferralCount: 0,
    createdAt: now,
  });
  createdIds.referrers.push(insert.insertedId);
  await handleActivationDecision(insert.insertedId.toString(), fakeDecision({ documentNumber }));
  const referrer = await collections.referrers.findOne({ _id: insert.insertedId });
  return referrer;
}

async function makeReferral(referrerEmail, referredLabel) {
  const now = new Date().toISOString();
  const referredEmail = email(referredLabel);
  const insert = await collections.referrals.insertOne({
    referrerEmail,
    referredEmail,
    status: "pending",
    createdAt: now,
  });
  createdIds.referrals.push(insert.insertedId);
  return { id: insert.insertedId, referredEmail };
}

// ============================================================
test("activation: Approved decision verifies the referrer and issues a code", async () => {
  const referrer = await makeVerifiedReferrer("act-happy", { documentNumber: "DOC-ACT-HAPPY" });
  assert.equal(referrer.status, "verified");
  assert.ok(referrer.referralCode, "expected a referral code to be issued");
});

test("activation: Declined decision rejects without crediting anything", async () => {
  const now = new Date().toISOString();
  const referrerEmail = email("act-declined");
  const insert = await collections.referrers.insertOne({ email: referrerEmail, status: "pending", successfulReferralCount: 0, createdAt: now });
  createdIds.referrers.push(insert.insertedId);
  await handleActivationDecision(insert.insertedId.toString(), fakeDecision({ status: "Declined" }));
  const referrer = await collections.referrers.findOne({ _id: insert.insertedId });
  assert.equal(referrer.status, "rejected");
  assert.equal(referrer.rejectionReason, "Declined");
});

// ============================================================
test("self-referral: referred person's identity matches the referrer's own -> rejected, not credited", async () => {
  const sharedDoc = "DOC-SELF-REFERRAL";
  const referrer = await makeVerifiedReferrer("self-referrer", { documentNumber: sharedDoc });
  const { id: referralId, referredEmail } = await makeReferral(referrer.email, "self-referred");

  await handleReferralDecision(referralId.toString(), fakeDecision({ documentNumber: sharedDoc }));

  const referral = await collections.referrals.findOne({ _id: referralId });
  assert.equal(referral.status, "rejected");
  assert.equal(referral.rejectionReason, "self_referral");

  const rewards = await collections.referralRewards.find({ referralId }).toArray();
  assert.equal(rewards.length, 0, "no rewards should have been recorded for a blocked self-referral");

  const identityUnderReferredEmail = await collections.kycIdentities.findOne({ email: referredEmail });
  assert.equal(identityUnderReferredEmail, null, "the referred email should never get an identity record for a blocked self-referral");
});

// ============================================================
test("duplicate identity: same document already used under a different referred email -> rejected", async () => {
  const referrer = await makeVerifiedReferrer("dup-referrer", { documentNumber: "DOC-DUP-REFERRER" });
  const sharedDoc = "DOC-FARMED-IDENTITY";

  const first = await makeReferral(referrer.email, "dup-first");
  await handleReferralDecision(first.id.toString(), fakeDecision({ documentNumber: sharedDoc }));
  const firstReferral = await collections.referrals.findOne({ _id: first.id });
  assert.equal(firstReferral.status, "verified", "sanity check: the first use of this document should succeed");

  const second = await makeReferral(referrer.email, "dup-second");
  await handleReferralDecision(second.id.toString(), fakeDecision({ documentNumber: sharedDoc }));
  const secondReferral = await collections.referrals.findOne({ _id: second.id });
  assert.equal(secondReferral.status, "rejected");
  assert.equal(secondReferral.rejectionReason, "duplicate_identity");

  const rewardsForSecond = await collections.referralRewards.find({ referralId: second.id }).toArray();
  assert.equal(rewardsForSecond.length, 0);

  // Cleanup this test's crediting side-effect on the real global counter —
  // the first referral above genuinely credited 0.5 INAYA to production data.
  await collections.programCounters.updateOne({ _id: "global" }, { $inc: { totalDistributedInaya: -0.5, totalSuccessfulReferrals: -1 } });
  await collections.referrers.updateOne({ _id: referrer._id }, { $inc: { successfulReferralCount: -1 } });
});

// ============================================================
test("duplicate webhook: reprocessing an already-verified referral does not double-credit", async () => {
  const referrer = await makeVerifiedReferrer("idempotent-referrer", { documentNumber: "DOC-IDEMPOTENT" });
  const { id: referralId } = await makeReferral(referrer.email, "idempotent-referred");
  const decision = fakeDecision({ documentNumber: "DOC-IDEMPOTENT-REFERRED" });

  await handleReferralDecision(referralId.toString(), decision);
  const afterFirst = await collections.referrals.findOne({ _id: referralId });
  assert.equal(afterFirst.status, "verified");

  // Simulate Didit redelivering the same webhook (e.g. its own retry policy,
  // or a genuine duplicate event) with a fresh event_id but the same decision.
  await handleReferralDecision(referralId.toString(), decision);

  const rewards = await collections.referralRewards.find({ referralId }).toArray();
  assert.equal(rewards.length, 2, "exactly one referrer + one referred reward, not four, after reprocessing");

  const referrerAfter = await collections.referrers.findOne({ _id: referrer._id });
  assert.equal(referrerAfter.successfulReferralCount, 1, "successfulReferralCount must not increment twice");

  // Cleanup this test's crediting side-effect on the real global counter.
  await collections.programCounters.updateOne({ _id: "global" }, { $inc: { totalDistributedInaya: -0.5, totalSuccessfulReferrals: -1 } });
});

// ============================================================
test("atomicCappedIncrement: allows increments under the cap, blocks ones that would exceed it", async () => {
  const testDocId = `test-cap-${RUN_ID}-basic`;
  await collections.programCounters.insertOne({ _id: testDocId, value: 0 });

  const ok = await atomicCappedIncrement({
    collection: collections.programCounters,
    filter: { _id: testDocId },
    capField: "value",
    capLimit: 10,
    incFields: { value: 6 },
  });
  assert.ok(ok, "6 -> 6 should succeed under a cap of 10");
  assert.equal(ok.value, 6);

  const blocked = await atomicCappedIncrement({
    collection: collections.programCounters,
    filter: { _id: testDocId },
    capField: "value",
    capLimit: 10,
    incFields: { value: 6 },
  });
  assert.equal(blocked, null, "6 + 6 = 12 exceeds a cap of 10, must be blocked");

  const stillAllowed = await atomicCappedIncrement({
    collection: collections.programCounters,
    filter: { _id: testDocId },
    capField: "value",
    capLimit: 10,
    incFields: { value: 4 },
  });
  assert.ok(stillAllowed, "6 + 4 = 10 is exactly at the cap and should be allowed");
  assert.equal(stillAllowed.value, 10);
});

test("atomicCappedIncrement: does not throw when the cap is already reached on a pre-existing doc (the bug this replaced)", async () => {
  const testDocId = `test-cap-${RUN_ID}-preexisting`;
  await collections.programCounters.insertOne({ _id: testDocId, value: 9.8 });

  // This is exactly the scenario that used to throw E11000 with the old
  // upsert:true implementation: a document already exists at this _id, but
  // fails the $lte filter. Must resolve to null, not an exception.
  await assert.doesNotReject(async () => {
    const result = await atomicCappedIncrement({
      collection: collections.programCounters,
      filter: { _id: testDocId },
      capField: "value",
      capLimit: 10,
      incFields: { value: 0.5 },
    });
    assert.equal(result, null);
  });
});

// ============================================================
test("per-referrer cap: reaching MAX_REFERRALS_PER_REFERRER blocks further crediting and rolls back the global counter", async () => {
  const referrer = await makeVerifiedReferrer("cap-referrer", { documentNumber: "DOC-CAP-REFERRER" });
  await collections.referrers.updateOne({ _id: referrer._id }, { $set: { successfulReferralCount: MAX_REFERRALS_PER_REFERRER } });

  const before = await collections.programCounters.findOne({ _id: "global" });

  const { id: referralId } = await makeReferral(referrer.email, "cap-referred");
  await handleReferralDecision(referralId.toString(), fakeDecision({ documentNumber: "DOC-CAP-REFERRED" }));

  const referral = await collections.referrals.findOne({ _id: referralId });
  assert.equal(referral.status, "rejected");
  assert.equal(referral.rejectionReason, "referrer_cap_reached");

  const referrerAfter = await collections.referrers.findOne({ _id: referrer._id });
  assert.equal(referrerAfter.successfulReferralCount, MAX_REFERRALS_PER_REFERRER, "must not increment past the cap");

  const after = await collections.programCounters.findOne({ _id: "global" });
  assert.equal(after.totalDistributedInaya, before.totalDistributedInaya, "global counter must be rolled back to exactly its prior value");
  assert.equal(after.totalSuccessfulReferrals, before.totalSuccessfulReferrals, "global referral count must be rolled back to exactly its prior value");

  const rewards = await collections.referralRewards.find({ referralId }).toArray();
  assert.equal(rewards.length, 0, "no rewards should exist when the per-referrer cap blocks crediting");
});
