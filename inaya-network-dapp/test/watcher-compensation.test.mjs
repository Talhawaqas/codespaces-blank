// test/watcher-compensation.test.mjs
//
// Real-database tests for SQA-037's manual admin compensation mechanism.
// Same disposable-wallet convention as test/watcher-pioneer.test.mjs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  getWatcherCollections, ensureWatcherIndexes, enrollWallet,
  grantCompensationPoints, listCompensationGrants, WATCHER_MAX_POINTS_PER_WALLET,
  ENROLLMENT_PROMO_POINTS,
} from "../src/lib/watcherPioneer.js";
import mongoClientPromise from "../src/lib/mongodb.js";

let collections; let counterSnapshot;
const createdWallets = [];

before(async () => {
  await ensureWatcherIndexes();
  collections = await getWatcherCollections();
  const counter = await collections.programCounters.findOne({ _id: "global" });
  counterSnapshot = counter?.enrolledWalletCount ?? 0;
});
after(async () => {
  await collections.pioneers.deleteMany({ walletAddress: { $in: createdWallets } });
  await collections.sessions.deleteMany({ walletAddress: { $in: createdWallets } });
  await collections.compensationLog.deleteMany({ walletAddress: { $in: createdWallets } });
  await collections.programCounters.updateOne({ _id: "global" }, { $set: { enrolledWalletCount: counterSnapshot } });
  const client = await mongoClientPromise;
  await client.close();
});

async function enrollFresh() {
  const w = ethers.Wallet.createRandom();
  const address = w.address.toLowerCase();
  await enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: true });
  createdWallets.push(address);
  return address;
}

test("grantCompensationPoints: credits an enrolled wallet and logs it first", async () => {
  // enrollFresh() itself now grants ENROLLMENT_PROMO_POINTS automatically
  // (the active new-enrollment promo) — that's the wallet's real starting
  // balance for this test, not 0.
  const address = await enrollFresh();
  const result = await grantCompensationPoints({ walletAddress: address, points: 5000, reason: "lost history, user sent screenshot", grantedBy: "talha" });

  assert.equal(result.grantedPoints, 5000);
  assert.equal(result.totalPointsAfter, ENROLLMENT_PROMO_POINTS + 5000);
  assert.equal(result.truncatedByCap, false);

  const pioneer = await collections.pioneers.findOne({ walletAddress: address });
  assert.equal(pioneer.totalPoints, ENROLLMENT_PROMO_POINTS + 5000);

  const logEntry = await collections.compensationLog.findOne({ _id: result.logId });
  assert.equal(logEntry.walletAddress, address);
  assert.equal(logEntry.grantedPoints, 5000);
  assert.equal(logEntry.reason, "lost history, user sent screenshot");
  assert.equal(logEntry.grantedBy, "talha");
  assert.equal(logEntry.pointsBeforeGrant, ENROLLMENT_PROMO_POINTS);
});

test("grantCompensationPoints: truncates at the lifetime cap instead of over-crediting", async () => {
  const address = await enrollFresh();
  await collections.pioneers.updateOne({ walletAddress: address }, { $set: { totalPoints: WATCHER_MAX_POINTS_PER_WALLET - 100 } });

  const result = await grantCompensationPoints({ walletAddress: address, points: 5000, reason: "test", grantedBy: "talha" });
  assert.equal(result.grantedPoints, 100, "should only grant the remaining headroom, not the full request");
  assert.equal(result.truncatedByCap, true);
  assert.equal(result.totalPointsAfter, WATCHER_MAX_POINTS_PER_WALLET);
});

test("grantCompensationPoints: rejects a wallet that isn't enrolled", async () => {
  const w = ethers.Wallet.createRandom();
  await assert.rejects(
    () => grantCompensationPoints({ walletAddress: w.address, points: 100, reason: "x", grantedBy: "talha" }),
    /isn't an enrolled/i
  );
});

test("grantCompensationPoints: rejects missing reason or grantedBy — never an unexplained credit", async () => {
  const address = await enrollFresh();
  await assert.rejects(() => grantCompensationPoints({ walletAddress: address, points: 100, reason: "", grantedBy: "talha" }), /reason/i);
  await assert.rejects(() => grantCompensationPoints({ walletAddress: address, points: 100, reason: "x", grantedBy: "" }), /grantedBy/i);
});

test("grantCompensationPoints: rejects a non-positive or non-integer point amount", async () => {
  const address = await enrollFresh();
  await assert.rejects(() => grantCompensationPoints({ walletAddress: address, points: 0, reason: "x", grantedBy: "talha" }), /positive whole number/i);
  await assert.rejects(() => grantCompensationPoints({ walletAddress: address, points: -50, reason: "x", grantedBy: "talha" }), /positive whole number/i);
  await assert.rejects(() => grantCompensationPoints({ walletAddress: address, points: 12.5, reason: "x", grantedBy: "talha" }), /positive whole number/i);
});

test("listCompensationGrants: returns grants newest first and nothing is ever deleted by the flow itself", async () => {
  // enrollFresh() logs its own promo-bonus grant first, so there are 3
  // entries for this wallet total, oldest to newest: promo, "first", "second".
  const address = await enrollFresh();
  await grantCompensationPoints({ walletAddress: address, points: 10, reason: "first", grantedBy: "talha" });
  await grantCompensationPoints({ walletAddress: address, points: 20, reason: "second", grantedBy: "talha" });

  const all = await listCompensationGrants();
  const mine = all.filter((g) => g.walletAddress === address);
  assert.equal(mine.length, 3);
  assert.equal(mine[0].reason, "second", "newest first");
  assert.equal(mine[1].reason, "first");
  assert.equal(mine[2].grantedBy, "system:enrollment-promo", "oldest is the automatic enrollment bonus");
});

test("enrollWallet: a new enrollment during the promo window gets the 11,000-point bonus automatically, and it's logged", async () => {
  const w = ethers.Wallet.createRandom();
  const address = w.address.toLowerCase();
  const { enrollWallet, ENROLLMENT_PROMO_POINTS } = await import("../src/lib/watcherPioneer.js");

  const { pioneer, alreadyEnrolled } = await enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: true });
  createdWallets.push(address);

  assert.equal(alreadyEnrolled, false);
  assert.equal(pioneer.totalPoints, ENROLLMENT_PROMO_POINTS, "the returned pioneer should already reflect the bonus");

  const stored = await collections.pioneers.findOne({ walletAddress: address });
  assert.equal(stored.totalPoints, ENROLLMENT_PROMO_POINTS);

  const logEntry = await collections.compensationLog.findOne({ walletAddress: address });
  assert.ok(logEntry, "the bonus must be logged to the audit trail, same as a manual grant");
  assert.equal(logEntry.grantedPoints, ENROLLMENT_PROMO_POINTS);
  assert.equal(logEntry.grantedBy, "system:enrollment-promo");
  assert.match(logEntry.reason, /automatic new-enrollment goodwill bonus/);
});

test("enrollWallet: repeat enrollment of an already-enrolled wallet does NOT re-grant the bonus", async () => {
  const w = ethers.Wallet.createRandom();
  const address = w.address.toLowerCase();
  const { enrollWallet, ENROLLMENT_PROMO_POINTS } = await import("../src/lib/watcherPioneer.js");

  await enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: true });
  createdWallets.push(address);

  const second = await enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: true });
  assert.equal(second.alreadyEnrolled, true);

  const logCount = await collections.compensationLog.countDocuments({ walletAddress: address });
  assert.equal(logCount, 1, "the bonus should only ever be granted once, on the actual first enrollment");

  const stored = await collections.pioneers.findOne({ walletAddress: address });
  assert.equal(stored.totalPoints, ENROLLMENT_PROMO_POINTS, "still just the one bonus, not doubled");
});
