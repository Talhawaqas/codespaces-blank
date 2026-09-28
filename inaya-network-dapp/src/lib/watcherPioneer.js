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
import mongoClientPromise from "./mongodb.js";
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

// SQA-037 incident goodwill promo — every wallet that enrolls between now
// and this cutoff gets an automatic bonus, on top of whatever they earn
// normally, logged the same audited way as a manual admin compensation
// grant (see grantCompensationPoints below). Applies to NEW enrollments
// only (the pre-existing wallets enrolled before this incident were
// credited separately, one time, via the same mechanism — see
// test/_scratch-mass-compensate.mjs). Time-boxed on purpose so it stays a
// stated, limited-time gesture rather than a silent permanent rule.
export const ENROLLMENT_PROMO_POINTS = 11000;
export const ENROLLMENT_PROMO_CUTOFF = new Date("2026-10-05T03:59:59.000Z"); // Sunday 2026-10-04, 23:59:59 America/New_York (EDT, UTC-4)

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
//   watcher_compensation_log   — append-only record of every manual admin
//                                point grant (SQA-037, see grantCompensationPoints
//                                below). Never mutated or deleted, only
//                                inserted to — the permanent, honest record
//                                of "this wallet was credited N points by an
//                                admin, for this stated reason, at this
//                                time" that a raw database edit would not
//                                leave behind.
// ============================================================

export async function getWatcherCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    pioneers: db.collection("watcher_pioneers"),
    sessions: db.collection("watcher_sessions"),
    programCounters: db.collection("watcher_program_counters"),
    compensationLog: db.collection("watcher_compensation_log"),
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
  if (Math.abs(Date.now() - timestamp) > MAX_SIGNATURE_AGE_MS) {
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
    let finalPioneer = { ...pioneer, _id: insertedId };

    if (now <= ENROLLMENT_PROMO_CUTOFF) {
      // Best-effort — a promo-bonus hiccup must never fail the enrollment
      // itself (the wallet is already validly enrolled at this point).
      // grantCompensationPoints logs to watcher_compensation_log first,
      // same as a manual admin grant, so this is fully auditable too.
      try {
        const grant = await grantCompensationPoints({
          walletAddress: wallet,
          points: ENROLLMENT_PROMO_POINTS,
          reason: `automatic new-enrollment goodwill bonus (promo through ${ENROLLMENT_PROMO_CUTOFF.toISOString()})`,
          grantedBy: "system:enrollment-promo",
        });
        finalPioneer = { ...finalPioneer, totalPoints: grant.totalPointsAfter };
      } catch (promoErr) {
        console.error("watcher enrollment promo bonus failed (enrollment itself still succeeded):", promoErr);
      }
    }

    return { pioneer: finalPioneer, alreadyEnrolled: false };
  } catch (err) {
    // Compensate — a failed enrollment must never permanently consume a
    // cap slot (e.g. a genuine race on the walletAddress unique index for
    // two near-simultaneous first-time enroll calls).
    await programCounters.updateOne({ _id: "global" }, { $inc: { enrolledWalletCount: -1 } });
    throw err;
  }
}

/** Atomic claim-then-credit, now inside a real MongoDB transaction (SQA-036 —
 *  reported as users' Watcher earnings "disappearing"). The original fix
 *  here (still described below) protected against DOUBLE-crediting via two
 *  separate writes; it did not protect against a crash, thrown error, or
 *  serverless timeout landing BETWEEN those two writes, which left the
 *  session permanently stuck at status:"completed", pointsAwarded:null —
 *  visibly finished, but its 200 points never credited, and nothing ever
 *  retried it because the first write's own filter (status:"active") could
 *  never match a "completed" document again. Reproduced directly against
 *  the real database before this fix: a session forced into that exact
 *  state stayed at 0 credited points across repeated status reads.
 *
 *  Both writes (claim + credit) now happen inside one transaction — either
 *  both land or neither does, so that stuck state can no longer occur going
 *  forward. A second claim path recovers any session already stuck in it
 *  from before this fix (status:"completed", pointsAwarded:null) the next
 *  time that wallet's status is read or it starts a new session — no manual
 *  backfill needed for those, since this function is already called lazily
 *  on every read.
 *
 *  Concurrency-safety is unchanged in spirit from the original design:
 *  each claim (fresh or recovery) is a findOneAndUpdate filtered on the
 *  document's CURRENT state — exactly document-workflow.js's
 *  transitionDocument() idiom — so only the caller whose update actually
 *  matches proceeds to award points. Two callers racing the same document
 *  inside overlapping transactions is resolved by the driver's own
 *  transaction-conflict retry (built into withTransaction), not by this
 *  code. */
export async function settleExpiredSession(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  const { pioneers, sessions } = await getWatcherCollections();
  const now = new Date();

  const client = await mongoClientPromise;
  const mongoSession = client.startSession();
  let result = null;
  try {
    await mongoSession.withTransaction(async () => {
      let claimed = await sessions.findOneAndUpdate(
        { walletAddress: wallet, status: "active", expiresAt: { $lte: now } },
        { $set: { status: "completed", settledAt: now } },
        { returnDocument: "after", session: mongoSession }
      );

      if (!claimed) {
        // Recovery path — a session left stuck by the pre-fix version of
        // this function (see comment above). Filtering on pointsAwarded:
        // null is itself the concurrency guard: once a winning transaction
        // sets it to a real number and commits, this filter stops matching
        // for any later/losing caller.
        claimed = await sessions.findOneAndUpdate(
          { walletAddress: wallet, status: "completed", pointsAwarded: null },
          { $set: { settledAt: now } },
          { returnDocument: "after", session: mongoSession }
        );
      }
      if (!claimed) return; // nothing to settle — result stays null

      const pioneer = await pioneers.findOne({ walletAddress: wallet }, { session: mongoSession });
      const pointsToAward = Math.max(0, Math.min(WATCHER_POINTS_PER_SESSION, WATCHER_MAX_POINTS_PER_WALLET - (pioneer?.totalPoints || 0)));

      if (pointsToAward > 0) {
        await atomicCappedIncrement({
          collection: pioneers,
          filter: { walletAddress: wallet },
          capField: "totalPoints",
          capLimit: WATCHER_MAX_POINTS_PER_WALLET,
          incFields: { totalPoints: pointsToAward },
          session: mongoSession,
        });
      }
      await sessions.updateOne({ _id: claimed._id }, { $set: { pointsAwarded: pointsToAward } }, { session: mongoSession });

      result = { ...claimed, pointsAwarded: pointsToAward };
    });
  } finally {
    await mongoSession.endSession();
  }

  return result;
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

// ============================================================
// Manual admin compensation (SQA-037)
//
// Built for a real incident: pre-existing Watcher point history became
// unrecoverable (no database backup existed on the plan in use, and an
// exhaustive search — app code, Vercel logs, the on-chain custody contract,
// the mobile app's own storage, full git history in both repos — found no
// surviving copy anywhere). This does not restore the original numbers; it
// gives an admin an audited way to credit a wallet based on whatever
// evidence the affected user can provide (a screenshot, their own record),
// instead of hand-editing the database with no trail at all.
//
// Every grant is permanently logged to watcher_compensation_log BEFORE the
// points are credited (log-then-credit, the safer order if the process dies
// between the two writes — an unresolved logged grant is a discrepancy an
// admin can review and finish, wrongly-credited points with no record at
// all are not recoverable the same way). The credit itself reuses the same
// capped, atomic increment every session-completion credit uses, so a
// compensation grant can never push a wallet over the same 100,000-point
// lifetime cap a normal session would respect.
// ============================================================

/** wallet must already be an enrolled pioneer — this credits an existing
 *  account, it does not create one. points must be a positive integer.
 *  reason and grantedBy (the admin's own identifier — e.g. "talha", not a
 *  secret) are both required so the log entry is never ambiguous about who
 *  approved what or why. Returns the log entry actually written, including
 *  the wallet's resulting totalPoints and how much of the requested amount
 *  was actually applied (truncated at the cap, same as a normal session). */
export async function grantCompensationPoints({ walletAddress, points, reason, grantedBy }) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) throw new Error("walletAddress is required.");
  if (!Number.isInteger(points) || points <= 0) throw new Error("points must be a positive whole number.");
  if (!reason || !reason.trim()) throw new Error("A reason is required for every compensation grant.");
  if (!grantedBy || !grantedBy.trim()) throw new Error("grantedBy (who approved this) is required.");

  const { pioneers, compensationLog } = await getWatcherCollections();
  const pioneer = await pioneers.findOne({ walletAddress: wallet });
  if (!pioneer) throw new Error("This wallet isn't an enrolled Watcher Pioneer — nothing to credit.");

  const pointsToGrant = Math.max(0, Math.min(points, WATCHER_MAX_POINTS_PER_WALLET - (pioneer.totalPoints || 0)));
  const now = new Date();

  // Logged first, deliberately — see the header comment above.
  const { insertedId } = await compensationLog.insertOne({
    walletAddress: wallet,
    requestedPoints: points,
    grantedPoints: pointsToGrant,
    reason: reason.trim(),
    grantedBy: grantedBy.trim(),
    grantedAt: now,
    pointsBeforeGrant: pioneer.totalPoints || 0,
  });

  let updated = pioneer;
  if (pointsToGrant > 0) {
    updated = await atomicCappedIncrement({
      collection: pioneers,
      filter: { walletAddress: wallet },
      capField: "totalPoints",
      capLimit: WATCHER_MAX_POINTS_PER_WALLET,
      incFields: { totalPoints: pointsToGrant },
    });
  }

  return {
    logId: insertedId,
    walletAddress: wallet,
    requestedPoints: points,
    grantedPoints: pointsToGrant,
    totalPointsAfter: updated?.totalPoints ?? pioneer.totalPoints,
    truncatedByCap: pointsToGrant < points,
  };
}

/** Full compensation history — every grant, newest first. Nothing is ever
 *  deleted from this collection, so this is always the complete record. */
export async function listCompensationGrants() {
  const { compensationLog } = await getWatcherCollections();
  return compensationLog.find({}).sort({ grantedAt: -1 }).toArray();
}
