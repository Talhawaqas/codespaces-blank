// test/watcher-pioneer.test.mjs
//
// Tests for the testnet-only Watcher Pioneer Program's core atomicity and
// anti-abuse logic. Runs against the REAL configured MongoDB (no test-DB
// override exists in this project — same constraint as
// test/referral-webhook-logic.test.mjs, which this file's structure
// mirrors directly), using randomly-suffixed disposable wallet addresses.
//
// The one shared, non-disposable piece of state is watcher_program_counters'
// single "global" doc (enrolledWalletCount). Every test that enrolls a real
// wallet permanently increments it unless reversed — this suite snapshots
// its value in before() and hard-resets it back to that exact snapshot in
// after(), after deleting every test-created pioneer/session doc. This is
// the same compensating-mutation discipline test/referral-webhook-logic.test.mjs
// uses for its own shared program_counters doc.
//
// Scope note: the upload-qualifying path's on-chain transaction-receipt
// check (verifyUploadTxSucceeded, inside startSession) requires a REAL,
// mined BSC Testnet transaction to exercise honestly — not something a unit
// test can fabricate without mocking the RPC layer (which this codebase
// doesn't do anywhere). That specific path is exercised manually in a
// separate signed-payload script against a running dev server, per the
// implementation plan. What's covered directly here instead is the
// database-level guarantee that actually prevents txHash reuse (the partial
// unique index) — the real safety mechanism, independent of whether
// startSession's own on-chain call is reachable in this environment.
//
// Run with: node --test test/watcher-pioneer.test.mjs
// Requires MONGODB_URI to be set (e.g. `set -a && source .env.local && set +a`).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import {
  getWatcherCollections,
  ensureWatcherIndexes,
  buildWatcherMessage,
  verifyWatcherAuth,
  enrollWallet,
  startSession,
  settleExpiredSession,
  getPioneerStatus,
  WATCHER_MAX_WALLETS,
  WATCHER_POINTS_PER_SESSION,
  WATCHER_MAX_POINTS_PER_WALLET,
} from "../src/lib/watcherPioneer.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);

function freshWallet() {
  return ethers.Wallet.createRandom();
}

let collections;
let counterSnapshot;
const createdWallets = []; // lowercased addresses this run enrolled, for cleanup

before(async () => {
  await ensureWatcherIndexes();
  collections = await getWatcherCollections();
  const counter = await collections.programCounters.findOne({ _id: "global" });
  counterSnapshot = counter?.enrolledWalletCount ?? 0;
});

after(async () => {
  await collections.pioneers.deleteMany({ walletAddress: { $in: createdWallets } });
  await collections.sessions.deleteMany({ walletAddress: { $in: createdWallets } });
  // Also sweep anything created under the disambiguated-txHash test, whose
  // wallets aren't enrolled pioneers (no counter impact from those).
  await collections.sessions.deleteMany({ qualifyingRef: { $regex: `^test-tx-${RUN_ID}-` } });
  // Hard-reset, not a relative decrement — correctly undoes every
  // enrollment this run performed (including the forced-near-cap test
  // below) in one operation, regardless of how many happened.
  await collections.programCounters.updateOne({ _id: "global" }, { $set: { enrolledWalletCount: counterSnapshot } });

  const client = await mongoClientPromise;
  await client.close();
});

async function enrollFresh() {
  const w = freshWallet();
  const address = w.address.toLowerCase();
  const { pioneer } = await enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: true });
  createdWallets.push(address);
  return { wallet: w, address, pioneer };
}

// ============================================================
test("enrollWallet: succeeds once, consumes exactly one cap slot, and is idempotent on repeat", async () => {
  const before = await collections.programCounters.findOne({ _id: "global" });
  const { address } = await enrollFresh();

  const after1 = await collections.programCounters.findOne({ _id: "global" });
  assert.equal(after1.enrolledWalletCount, before.enrolledWalletCount + 1);

  const { alreadyEnrolled } = await enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: true });
  assert.equal(alreadyEnrolled, true);

  const after2 = await collections.programCounters.findOne({ _id: "global" });
  assert.equal(after2.enrolledWalletCount, before.enrolledWalletCount + 1, "repeat enrollment must not consume a second slot");
});

test("enrollWallet: rejects unless both followedX and joinedTelegram are true", async () => {
  const w = freshWallet();
  const address = w.address.toLowerCase();
  await assert.rejects(
    () => enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: false }),
    /follow.*joined Telegram/i
  );
  const pioneer = await collections.pioneers.findOne({ walletAddress: address });
  assert.equal(pioneer, null, "no pioneer doc should exist after a rejected enrollment");
});

test("enrollWallet: cap enforcement — the wallet at the limit is rejected and the counter isn't corrupted", async () => {
  await collections.programCounters.updateOne({ _id: "global" }, { $set: { enrolledWalletCount: WATCHER_MAX_WALLETS - 1 } });

  const { address: firstAddress } = await enrollFresh(); // pushes count to exactly WATCHER_MAX_WALLETS
  const atCap = await collections.programCounters.findOne({ _id: "global" });
  assert.equal(atCap.enrolledWalletCount, WATCHER_MAX_WALLETS);

  const w2 = freshWallet();
  await assert.rejects(
    () => enrollWallet({ walletAddress: w2.address.toLowerCase(), followedX: true, joinedTelegram: true }),
    /full/i
  );

  const stillAtCap = await collections.programCounters.findOne({ _id: "global" });
  assert.equal(stillAtCap.enrolledWalletCount, WATCHER_MAX_WALLETS, "a rejected enrollment must not have touched the counter");
  const w2Pioneer = await collections.pioneers.findOne({ walletAddress: w2.address.toLowerCase() });
  assert.equal(w2Pioneer, null);

  // Restore immediately, not just in the suite's final after() — later tests
  // in this same run also call enrollFresh() and would otherwise find the
  // counter pinned at the cap for the rest of the run.
  await collections.programCounters.updateOne({ _id: "global" }, { $set: { enrolledWalletCount: counterSnapshot } });
});

// ============================================================
test("startSession: only one of two concurrent calls for the same wallet succeeds", async () => {
  const { address } = await enrollFresh();

  const results = await Promise.allSettled([
    startSession({ walletAddress: address, qualifyingMethod: "social", qualifyingRef: null }),
    startSession({ walletAddress: address, qualifyingMethod: "social", qualifyingRef: null }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one concurrent session-start should succeed");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already have an active/i);

  const activeCount = await collections.sessions.countDocuments({ walletAddress: address, status: "active" });
  assert.equal(activeCount, 1);
});

test("startSession: rejects a wallet that isn't enrolled", async () => {
  const w = freshWallet();
  await assert.rejects(
    () => startSession({ walletAddress: w.address.toLowerCase(), qualifyingMethod: "social", qualifyingRef: null }),
    /isn't enrolled/i
  );
});

test("startSession: a wallet already at the points cap cannot start a new session", async () => {
  const { address } = await enrollFresh();
  await collections.pioneers.updateOne({ walletAddress: address }, { $set: { totalPoints: WATCHER_MAX_POINTS_PER_WALLET } });

  await assert.rejects(
    () => startSession({ walletAddress: address, qualifyingMethod: "social", qualifyingRef: null }),
    /lifetime cap/i
  );
});

// ============================================================
test("settleExpiredSession: awards exactly 200 points and flips status", async () => {
  const { address } = await enrollFresh();
  const startedAt = new Date(Date.now() - WATCHER_MAX_POINTS_PER_WALLET); // arbitrary past time, just needs to be < expiresAt < now
  const expiresAt = new Date(Date.now() - 1000); // already expired
  await collections.sessions.insertOne({
    walletAddress: address, qualifyingMethod: "social", qualifyingRef: null,
    startedAt, expiresAt, status: "active", pointsAwarded: null, settledAt: null,
  });

  const settled = await settleExpiredSession(address);
  assert.ok(settled, "expected the expired session to be settled");
  assert.equal(settled.pointsAwarded, WATCHER_POINTS_PER_SESSION);
  assert.equal(settled.status, "completed");

  const pioneer = await collections.pioneers.findOne({ walletAddress: address });
  assert.equal(pioneer.totalPoints, WATCHER_POINTS_PER_SESSION);
});

test("settleExpiredSession: concurrent settlement attempts on the same session never double-credit (the fixed race)", async () => {
  const { address } = await enrollFresh();
  const expiresAt = new Date(Date.now() - 1000);
  await collections.sessions.insertOne({
    walletAddress: address, qualifyingMethod: "social", qualifyingRef: null,
    startedAt: new Date(Date.now() - 2000), expiresAt, status: "active", pointsAwarded: null, settledAt: null,
  });

  const results = await Promise.all([
    settleExpiredSession(address),
    settleExpiredSession(address),
    settleExpiredSession(address),
  ]);
  const nonNull = results.filter((r) => r !== null);
  assert.equal(nonNull.length, 1, "exactly one of the concurrent settlement attempts should have claimed the session");

  const pioneer = await collections.pioneers.findOne({ walletAddress: address });
  assert.equal(pioneer.totalPoints, WATCHER_POINTS_PER_SESSION, "points must be credited exactly once, not once per concurrent caller");
});

test("settleExpiredSession: truncates the award to remaining headroom at the cap, not a full 200", async () => {
  const { address } = await enrollFresh();
  await collections.pioneers.updateOne({ walletAddress: address }, { $set: { totalPoints: WATCHER_MAX_POINTS_PER_WALLET - 50 } });
  await collections.sessions.insertOne({
    walletAddress: address, qualifyingMethod: "social", qualifyingRef: null,
    startedAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000),
    status: "active", pointsAwarded: null, settledAt: null,
  });

  const settled = await settleExpiredSession(address);
  assert.equal(settled.pointsAwarded, 50, "should award only the remaining headroom to the cap, not the full 200");

  const pioneer = await collections.pioneers.findOne({ walletAddress: address });
  assert.equal(pioneer.totalPoints, WATCHER_MAX_POINTS_PER_WALLET);
});

test("settleExpiredSession: a still-running session is left untouched", async () => {
  const { address } = await enrollFresh();
  await collections.sessions.insertOne({
    walletAddress: address, qualifyingMethod: "social", qualifyingRef: null,
    startedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
    status: "active", pointsAwarded: null, settledAt: null,
  });

  const settled = await settleExpiredSession(address);
  assert.equal(settled, null, "a non-expired session must not be settled");

  const stillActive = await collections.sessions.countDocuments({ walletAddress: address, status: "active" });
  assert.equal(stillActive, 1);
});

// ============================================================
test("upload txHash uniqueness: the database index rejects reusing the same qualifyingRef", async () => {
  const ref = `test-tx-${RUN_ID}-shared`;
  await collections.sessions.insertOne({
    walletAddress: `0x${RUN_ID}aaaa000000000000000000000000000000000`.slice(0, 42),
    qualifyingMethod: "upload", qualifyingRef: ref,
    startedAt: new Date(), expiresAt: new Date(Date.now() + 1000), status: "active", pointsAwarded: null, settledAt: null,
  });

  await assert.rejects(
    () => collections.sessions.insertOne({
      walletAddress: `0x${RUN_ID}bbbb000000000000000000000000000000000`.slice(0, 42),
      qualifyingMethod: "upload", qualifyingRef: ref,
      startedAt: new Date(), expiresAt: new Date(Date.now() + 1000), status: "active", pointsAwarded: null, settledAt: null,
    }),
    (err) => err?.code === 11000
  );
});

// ============================================================
test("verifyWatcherAuth: accepts a genuinely matching signature", async () => {
  const w = freshWallet();
  const timestamp = Date.now();
  const message = buildWatcherMessage({ action: "enroll", extra: { followedX: true, joinedTelegram: true }, timestamp });
  const signature = await w.signMessage(message);

  assert.doesNotThrow(() =>
    verifyWatcherAuth({ action: "enroll", extra: { followedX: true, joinedTelegram: true }, address: w.address, message, signature, timestamp })
  );
});

test("verifyWatcherAuth: rejects a tampered message", async () => {
  const w = freshWallet();
  const timestamp = Date.now();
  const message = buildWatcherMessage({ action: "enroll", extra: { followedX: true, joinedTelegram: true }, timestamp });
  const signature = await w.signMessage(message);
  const tampered = message.replace("followedX: true", "followedX: false");

  assert.throws(
    () => verifyWatcherAuth({ action: "enroll", extra: { followedX: false, joinedTelegram: true }, address: w.address, message: tampered, signature, timestamp }),
    /tampering|does not match/i
  );
});

test("verifyWatcherAuth: rejects an expired timestamp", async () => {
  const w = freshWallet();
  const timestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago — past the 5-minute window
  const message = buildWatcherMessage({ action: "enroll", extra: { followedX: true, joinedTelegram: true }, timestamp });
  const signature = await w.signMessage(message);

  assert.throws(
    () => verifyWatcherAuth({ action: "enroll", extra: { followedX: true, joinedTelegram: true }, address: w.address, message, signature, timestamp }),
    /expired/i
  );
});

// ============================================================
test("getPioneerStatus: reflects points, active session, and cap state; settles a due session on read", async () => {
  const { address } = await enrollFresh();

  const beforeSession = await getPioneerStatus(address);
  assert.equal(beforeSession.enrolled, true);
  assert.equal(beforeSession.totalPoints, 0);
  assert.equal(beforeSession.activeSession, null);

  await collections.sessions.insertOne({
    walletAddress: address, qualifyingMethod: "social", qualifyingRef: null,
    startedAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000),
    status: "active", pointsAwarded: null, settledAt: null,
  });

  const afterSettle = await getPioneerStatus(address);
  assert.equal(afterSettle.totalPoints, WATCHER_POINTS_PER_SESSION, "reading status should have lazily settled the expired session");
  assert.equal(afterSettle.activeSession, null);
  assert.equal(afterSettle.inayaEquivalent, WATCHER_POINTS_PER_SESSION / 1000);
});
