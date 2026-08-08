// src/lib/referrals.js
//
// Shared constants, ID generation, and identity-matching helpers for the
// email-based referral program (Didit KYC only — no wallet-connect
// anywhere in this feature, per the SOW). Rewards are recorded in MongoDB
// as accounting only; actual $INAYA distribution happens at mainnet via a
// future claim process, hence the nullable claimWalletAddress/distributedAt
// fields on referral_rewards below.
//
// Self-referral is only provable if BOTH sides of a referral have a
// verified identity on file — the SOW's literal flow only has the
// referred person doing KYC, which leaves no way to prove a referrer and
// their own second email are the same human. So referrers complete a
// one-time Didit KYC "activation" session before they can generate a
// referral code (POST /api/referrals/activate) — this was an explicit,
// confirmed product decision, not an assumption: it trades a slightly
// heavier referrer onboarding for self-referral/duplicate-identity
// detection that's actually real instead of email-string comparison.

import { randomBytes, createHash } from "node:crypto";
import { connectToDatabase } from "./mongodb.js";

export const REWARD_REFERRER_INAYA = 0.4;
export const REWARD_REFERRED_INAYA = 0.1;
export const REWARD_PER_SUCCESSFUL_REFERRAL_INAYA = REWARD_REFERRER_INAYA + REWARD_REFERRED_INAYA;
export const MAX_REFERRALS_PER_REFERRER = 1000;
export const GLOBAL_PROGRAM_CAP_INAYA = 150000;

export const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — avoids visual ambiguity
export const REFERRAL_CODE_LENGTH = 8;

export function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** For the public leaderboard — real emails aren't shown to other participants. */
export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return "****";
  const visible = local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
}

export function generateReferralCode() {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
  }
  return code;
}

/** Builds a stable fingerprint for a verified identity from Didit's id_verifications
 *  fields. document_number + issuing_state is the natural unique key for a physical
 *  ID document — full name alone isn't unique enough and varies in formatting. Hashed
 *  (not stored in plaintext) since this is derived from government ID data. */
export function computeIdentityFingerprint({ documentNumber, issuingState }) {
  if (!documentNumber) return null;
  const normalized = `${String(documentNumber).trim().toUpperCase()}|${String(issuingState || "").trim().toUpperCase()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

/** Pulls the fields we need for fingerprinting out of a Didit session decision.
 *  id_verifications is documented as a plural array (one entry per ID-verification
 *  node in the workflow graph) — we use the first entry, which is the only one for
 *  our single-step ID Verification workflow. */
export function extractIdentityFromDecision(decision) {
  const entry = decision?.id_verifications?.[0];
  if (!entry) return null;
  return {
    documentNumber: entry.document_number || entry.personal_number || null,
    issuingState: entry.issuing_state || null,
    fullName: entry.full_name || [entry.first_name, entry.last_name].filter(Boolean).join(" ") || null,
  };
}

// ============================================================
// Collections (all under the existing "inaya_network_corporate" DB —
// see connectToDatabase() in ./mongodb.js)
// ============================================================
//
//   referrers            — one per person who activated as a referrer
//   referrals             — one per (referrerEmail, referredEmail) invite
//   kyc_identities         — one per verified identity fingerprint <-> email,
//                            used for self-referral + duplicate-identity checks
//   referral_rewards      — accounting ledger, credited on a verified referral
//   program_counters      — single "global" doc for the atomic 150k cap
//   didit_webhook_events   — event_id idempotency log

/** Atomically checks-and-increments a capped counter field in one document —
 *  the exact pattern both the global 150k cap and the per-referrer 1000 cap
 *  need: "only apply this increment if the field will still be <= capLimit
 *  afterward." A single findOneAndUpdate makes the check-and-increment one
 *  atomic operation, safe under concurrent webhook deliveries. Returns the
 *  updated document, or null if applying incFields[capField] would push
 *  capField past capLimit (the doc already existing but failing the filter
 *  is what "cap reached" looks like — see ensureReferralIndexes()'s comment
 *  for why the target document must already exist before this runs;
 *  passing upsert:true here would reintroduce that exact bug). */
export async function atomicCappedIncrement({ collection, filter, capField, capLimit, incFields }) {
  const incAmount = incFields[capField];
  return collection.findOneAndUpdate(
    { ...filter, [capField]: { $lte: capLimit - incAmount } },
    { $inc: incFields },
    { returnDocument: "after" }
  );
}

/** Top-50 referrers strictly by successfulReferralCount — factored out of the
 *  route handler so it's testable without importing next/server (whose export
 *  map plain `node --test` can't resolve outside Next's own bundler; see
 *  test/referral-leaderboard.test.mjs). */
export async function getLeaderboardEntries(referrers) {
  const top = await referrers
    .find({ successfulReferralCount: { $gt: 0 } })
    .sort({ successfulReferralCount: -1, verifiedAt: 1 }) // tie-break: earlier activation ranks higher
    .limit(50)
    .project({ email: 1, successfulReferralCount: 1 })
    .toArray();

  return top.map((r, i) => ({
    rank: i + 1,
    email: maskEmail(r.email),
    successfulReferralCount: r.successfulReferralCount,
  }));
}

export async function getReferralCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    referrers: db.collection("referrers"),
    referrals: db.collection("referrals"),
    kycIdentities: db.collection("kyc_identities"),
    referralRewards: db.collection("referral_rewards"),
    programCounters: db.collection("program_counters"),
    webhookEvents: db.collection("didit_webhook_events"),
  };
}

let indexesEnsured = false;

/** Idempotent — safe to call on every cold start. createIndex() is a no-op if the
 *  index already exists with the same spec, so this doesn't need a separate migration step.
 *
 *  Also seeds the single "global" program_counters doc via a pure-equality upsert. This
 *  MUST happen here rather than inside the webhook's conditional cap-check update: mixing
 *  upsert:true with a query that has a non-equality condition (our $lte cap check) means
 *  Mongo can't derive the missing fields for an insert-on-no-match, and if a doc with that
 *  _id already exists but fails the $lte check, it throws a duplicate-key error instead of
 *  cleanly returning null. Seeding the doc up front means the cap-check update can run
 *  with upsert:false and a plain "no match -> null" result. */
export async function ensureReferralIndexes() {
  if (indexesEnsured) return;
  const { referrers, referrals, kycIdentities, referralRewards, webhookEvents, programCounters } = await getReferralCollections();

  await Promise.all([
    referrers.createIndex({ email: 1 }, { unique: true }),
    referrers.createIndex({ referralCode: 1 }, { unique: true, sparse: true }),
    referrers.createIndex({ successfulReferralCount: -1 }),
    referrals.createIndex({ referrerEmail: 1, referredEmail: 1 }, { unique: true }),
    referrals.createIndex({ diditSessionId: 1 }, { sparse: true }),
    referrals.createIndex({ status: 1 }),
    kycIdentities.createIndex({ identityFingerprint: 1 }),
    kycIdentities.createIndex({ email: 1 }, { unique: true }),
    referralRewards.createIndex({ user: 1 }),
    referralRewards.createIndex({ referralId: 1 }),
    webhookEvents.createIndex({ eventId: 1 }, { unique: true }),
    programCounters.updateOne(
      { _id: "global" },
      { $setOnInsert: { _id: "global", totalDistributedInaya: 0, totalSuccessfulReferrals: 0 } },
      { upsert: true }
    ),
  ]);

  indexesEnsured = true;
}
