// src/lib/watcherPioneer.js
//
// Testnet-only "Watcher Pioneer Program" — wallet-based enrollment capped at
// 2,500 wallets, off-chain points earned via repeating 24-hour "Watcher
// sessions." A session starts either by successfully uploading a file
// through the existing encrypt/shard/pin/on-chain-register pipeline
// (verified here via a real on-chain receipt check, not taken on faith) or
// by self-attesting a social task (like+retweet the latest X post) — both
// paths require a wallet signature, so at minimum every reward is tied to a
// wallet that actually signed for it.
//
// Off-chain bookkeeping only — no smart contract, no on-chain reward
// tracking. Fully isolated from src/lib/referrals.js's 150,000 INAYA
// program: separate collections, separate program_counters-equivalent doc,
// this file only ever IMPORTS atomicCappedIncrement from referrals.js
// (a pure, generic function), never touches its collections.
//
// Session cadence is "re-qualify every 24h," not auto-chaining: completing
// a session does not start the next one — a fresh upload or fresh social
// attest is required each time (confirmed product decision).

import { ethers } from "ethers";
import { connectToDatabase } from "./mongodb.js";
import { atomicCappedIncrement } from "./referrals.js";

// Same literal values already hardcoded in metadata-auth.js/custody.js/
// orgs/documents/route.js — those two consts aren't exported anywhere, and
// the existing repo convention (see wallet-storage-stats.js) is to
// duplicate them per-file rather than share them.
const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888";

export const WATCHER_MAX_WALLETS = 2500;
export const WATCHER_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
export const WATCHER_POINTS_PER_SESSION = 200;
export const WATCHER_POINTS_PER_INAYA = 1000;
export const WATCHER_MAX_POINTS_PER_WALLET = 100000; // = 100 INAYA
export const WATCHER_MAX_PROGRAM_LIABILITY_INAYA = (WATCHER_MAX_WALLETS * WATCHER_MAX_POINTS_PER_WALLET) / WATCHER_POINTS_PER_INAYA; // 250,000

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // 5 minutes — same window metadata-auth.js uses

export function normalizeWallet(address) {
  if (typeof address !== "string") return "";
  return address.trim().toLowerCase();
}

// ============================================================
// Collections (all new, under the existing "inaya_network_corporate" DB —
// see connectToDatabase() in ./mongodb.js). Fully separate from referrals.js's
// collections — no shared documents, no shared counters.
//
//   watcher_pioneers          — one per enrolled wallet
//   watcher_sessions           — one per 24h session (active + historical)
//   watcher_program_counters   — single "global" doc for the 2,500-wallet cap
// ============================================================

export async function getWatcherCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    pioneers: db.collection("watcher_pioneers"),
    sessions: db.collection("watcher_sessions"),
    programCounters: db.collection("watcher_program_counters"),
  };
}

let indexesEnsured = false;

/** Idempotent — safe to call on every cold start, same convention as
 *  ensureReferralIndexes(). Seeds the single "global" counter doc via a
 *  pure-equality upsert for the same reason referrals.js does: the capped
 *  increment below needs the field to already exist so its $lte filter can
 *  match on the very first enrollment. */
export async function ensureWatcherIndexes() {
  if (indexesEnsured) return;
  const { pioneers, sessions, programCounters } = await getWatcherCollections();

  await Promise.all([
    pioneers.createIndex({ walletAddress: 1 }, { unique: true }),
    sessions.createIndex(
      { walletAddress: 1 },
      { unique: true, partialFilterExpression: { status: "active" } }
    ),
    sessions.createIndex(
      { qualifyingMethod: 1, qualifyingRef: 1 },
      { unique: true, partialFilterExpression: { qualifyingMethod: "upload" } }
    ),
    sessions.createIndex({ walletAddress: 1, startedAt: -1 }),
    programCounters.updateOne(
      { _id: "global" },
      { $setOnInsert: { _id: "global", enrolledWalletCount: 0 } },
      { upsert: true }
    ),
  ]);

  indexesEnsured = true;
}

// ============================================================
// Wallet-signature verification — same technique as metadata-auth.js's
// verifyMetadataAuth (message reconstruction + ethers.verifyMessage +
// freshness window, fail-closed by throwing), independent message schema
// ("Inaya Watcher Pioneer Action" instead of "Inaya Metadata Action") since
// that file's own header comment warns against coupling unrelated message
// formats to it.
// ============================================================

/** Builds the exact same string the mobile client must sign — keep this in
 *  lockstep with inaya-mobile/src/utils/watcherApi.js's buildWatcherMessage(). */
export function buildWatcherMessage({ action, extra, timestamp }) {
  const lines = ["Inaya Watcher Pioneer Action", `action: ${action}`];
  if (extra) for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${String(value)}`);
  lines.push(`timestamp: ${timestamp}`);
  return lines.join("\n");
}

export function verifyWatcherAuth({ action, extra, address, message, signature, timestamp }) {
  if (!address || !message || !signature || typeof timestamp !== "number") {
    throw new Error("Missing auth fields — address, message, signature, and timestamp are all required.");
  }
  if (Date.now() - timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new Error("Signature expired — please retry.");
  }

  const expectedMessage = buildWatcherMessage({ action, extra, timestamp });
  if (message !== expectedMessage) {
    throw new Error("Signed message doesn't match the request fields — possible tampering.");
  }

  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Signature does not match the claimed address.");
  }
}

// ============================================================
// Program logic
// ============================================================

/** Idempotent — a repeat call for an already-enrolled wallet returns its
 *  existing record and consumes no cap slot. */
export async function enrollWallet({ walletAddress, followedX, joinedTelegram }) {
  const wallet = normalizeWallet(walletAddress);
  const { pioneers, programCounters } = await getWatcherCollections();

  const existing = await pioneers.findOne({ walletAddress: wallet });
  if (existing) {
    return { pioneer: existing, alreadyEnrolled: true };
  }

  if (!followedX || !joinedTelegram) {
    throw new Error("You must confirm you've followed X and joined Telegram to enroll.");
  }

  const updatedCounter = await atomicCappedIncrement({
    collection: programCounters,
    filter: { _id: "global" },
    capField: "enrolledWalletCount",
    capLimit: WATCHER_MAX_WALLETS,
    incFields: { enrolledWalletCount: 1 },
  });
  if (!updatedCounter) {
    throw new Error("The Watcher Pioneer Program is full — all 2,500 spots have been claimed.");
  }

  const now = new Date();
  try {
    const pioneer = {
      walletAddress: wallet,
      enrolledAt: now,
      followedX: true,
      joinedTelegram: true,
      totalPoints: 0,
      updatedAt: now,
    };
    const { insertedId } = await pioneers.insertOne(pioneer);
    return { pioneer: { ...pioneer, _id: insertedId }, alreadyEnrolled: false };
  } catch (err) {
    // Compensate — a failed enrollment must never permanently consume a
    // cap slot (e.g. a genuine race on the walletAddress unique index for
    // two near-simultaneous first-time enroll calls).
    await programCounters.updateOne({ _id: "global" }, { $inc: { enrolledWalletCount: -1 } });
    throw err;
  }
}

/** Atomic claim-then-credit — the fix for the settlement race caught during
 *  design review. Awarding points and marking the session complete used to
 *  be two separate writes; two concurrent settlement attempts on the same
 *  expired session (e.g. two status polls landing near the same expiry
 *  moment) would both see status:"active" and both award points, double-
 *  crediting a wallet. Fixed by claiming the session first with a single
 *  findOneAndUpdate filtered on its CURRENT state — exactly
 *  document-workflow.js's transitionDocument() idiom. Only the caller whose
 *  update actually matched proceeds to award points; a concurrent duplicate
 *  finds the session already "completed" and safely no-ops (returns null).
 *
 *  Called lazily from getPioneerStatus() (the codebase has no cron/queue
 *  infra to award points on a schedule) — this is what makes "settle on
 *  read" safe under concurrency, not just convenient. */
export async function settleExpiredSession(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  const { pioneers, sessions } = await getWatcherCollections();
  const now = new Date();

  const claimed = await sessions.findOneAndUpdate(
    { walletAddress: wallet, status: "active", expiresAt: { $lte: now } },
    { $set: { status: "completed", settledAt: now } },
    { returnDocument: "after" }
  );
  if (!claimed) return null; // no expired active session for this wallet — nothing to settle

  const pioneer = await pioneers.findOne({ walletAddress: wallet });
  const pointsToAward = Math.max(0, Math.min(WATCHER_POINTS_PER_SESSION, WATCHER_MAX_POINTS_PER_WALLET - (pioneer?.totalPoints || 0)));

  if (pointsToAward > 0) {
    await atomicCappedIncrement({
      collection: pioneers,
      filter: { walletAddress: wallet },
      capField: "totalPoints",
      capLimit: WATCHER_MAX_POINTS_PER_WALLET,
      incFields: { totalPoints: pointsToAward },
    });
  }
  await sessions.updateOne({ _id: claimed._id }, { $set: { pointsAwarded: pointsToAward } });

  return { ...claimed, pointsAwarded: pointsToAward };
}

/** Confirms a submitted upload transaction actually succeeded on-chain and
 *  was sent by the claiming wallet to the custody contract — the real
 *  verification behind the upload qualifying path, not taken on the
 *  client's word. */
async function verifyUploadTxSucceeded(txHash, walletAddress) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction not found or not yet mined — try again in a moment.");
  if (receipt.status !== 1) throw new Error("That upload transaction failed on-chain.");
  if (receipt.from.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("That transaction wasn't sent by this wallet.");
  }
  if (receipt.to?.toLowerCase() !== CUSTODY_ADDRESS.toLowerCase()) {
    throw new Error("That transaction isn't an Inaya custody upload.");
  }
}

/** Starts a new 24h Watcher session. Throws with a descriptive message on
 *  any rejection (not enrolled, already capped, tx verification failure,
 *  session already active) — routes translate these into HTTP responses. */
export async function startSession({ walletAddress, qualifyingMethod, qualifyingRef }) {
  const wallet = normalizeWallet(walletAddress);
  const { pioneers, sessions } = await getWatcherCollections();

  // Critical ordering: an expired-but-not-yet-settled "active" session
  // would otherwise block a legitimate new one via the partial unique index.
  await settleExpiredSession(wallet);

  const pioneer = await pioneers.findOne({ walletAddress: wallet });
  if (!pioneer) throw new Error("This wallet isn't enrolled in the Watcher Pioneer Program yet.");
  if (pioneer.totalPoints >= WATCHER_MAX_POINTS_PER_WALLET) {
    throw new Error("This wallet has reached its lifetime cap of 100,000 points (100 INAYA).");
  }

  if (qualifyingMethod === "upload") {
    if (!qualifyingRef) throw new Error("Missing transaction hash for the upload qualifying action.");
    await verifyUploadTxSucceeded(qualifyingRef, wallet);
  } else if (qualifyingMethod !== "social") {
    throw new Error(`Unknown qualifying method "${qualifyingMethod}".`);
  }

  const now = new Date();
  const session = {
    walletAddress: wallet,
    qualifyingMethod,
    qualifyingRef: qualifyingMethod === "upload" ? qualifyingRef : null,
    startedAt: now,
    expiresAt: new Date(now.getTime() + WATCHER_SESSION_DURATION_MS),
    status: "active",
    pointsAwarded: null,
    settledAt: null,
  };

  try {
    const { insertedId } = await sessions.insertOne(session);
    return { ...session, _id: insertedId };
  } catch (err) {
    if (err?.code === 11000) {
      // Two partial unique indexes can both throw E11000 from this insert —
      // inspect keyPattern to tell them apart rather than assuming which
      // fired. Misreporting a reused-txHash rejection as "session already
      // active" would be flatly wrong and confuse the user.
      const keys = err?.keyPattern ? Object.keys(err.keyPattern) : [];
      if (keys.includes("walletAddress") && !keys.includes("qualifyingMethod")) {
        const active = await sessions.findOne({ walletAddress: wallet, status: "active" });
        const err2 = new Error("You already have an active Watcher session.");
        err2.activeSession = active;
        throw err2;
      }
      throw new Error("That upload has already been used to start a Watcher session.");
    }
    throw err;
  }
}

/** Read-model for the mobile status screen. Settles any expired session
 *  first — the mechanism that makes cron-free settlement work. */
export async function getPioneerStatus(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  await settleExpiredSession(wallet);

  const { pioneers, sessions, programCounters } = await getWatcherCollections();
  const [pioneer, activeSession, counter] = await Promise.all([
    pioneers.findOne({ walletAddress: wallet }),
    sessions.findOne({ walletAddress: wallet, status: "active" }),
    programCounters.findOne({ _id: "global" }),
  ]);

  const enrolledWalletCount = counter?.enrolledWalletCount || 0;

  if (!pioneer) {
    return {
      enrolled: false,
      spotsRemaining: Math.max(0, WATCHER_MAX_WALLETS - enrolledWalletCount),
    };
  }

  return {
    enrolled: true,
    followedX: pioneer.followedX,
    joinedTelegram: pioneer.joinedTelegram,
    totalPoints: pioneer.totalPoints,
    inayaEquivalent: pioneer.totalPoints / WATCHER_POINTS_PER_INAYA,
    capReached: pioneer.totalPoints >= WATCHER_MAX_POINTS_PER_WALLET,
    activeSession: activeSession ? { startedAt: activeSession.startedAt, expiresAt: activeSession.expiresAt } : null,
    spotsRemaining: Math.max(0, WATCHER_MAX_WALLETS - enrolledWalletCount),
  };
}
