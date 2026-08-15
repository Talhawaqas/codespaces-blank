// src/lib/referral-webhook-logic.js
//
// The actual fraud-prevention and crediting logic for Didit webhook
// decisions, factored out of app/api/referrals/webhook/route.js so it can
// be exercised directly in tests (test/referral-webhook-logic.test.js)
// with a synthetic `decision` object — these functions never call the
// Didit API themselves, the route fetches the decision once and passes it
// in, which is what makes that possible.

import { ObjectId } from "mongodb";
import {
  getReferralCollections,
  generateReferralCode,
  computeIdentityFingerprint,
  extractIdentityFromDecision,
  atomicCappedIncrement,
  MAX_REFERRALS_PER_REFERRER,
  GLOBAL_PROGRAM_CAP_INAYA,
  REWARD_REFERRER_INAYA,
  REWARD_REFERRED_INAYA,
  REWARD_PER_SUCCESSFUL_REFERRAL_INAYA,
} from "./referrals.js";

const TERMINAL_NON_APPROVED_STATUSES = ["Declined", "Expired", "Kyc Expired", "Abandoned"];

// Case-insensitive compare — defense-in-depth against Didit ever sending a
// differently-cased status string than the "Approved" this code was
// written against; a silent case mismatch would otherwise leave a record
// stuck on "pending" forever with no error logged anywhere.
function isApproved(status) {
  return typeof status === "string" && status.toLowerCase() === "approved";
}
function isTerminalNonApproved(status) {
  return typeof status === "string" && TERMINAL_NON_APPROVED_STATUSES.some((s) => s.toLowerCase() === status.toLowerCase());
}

// ============================================================
// Referrer activation
// ============================================================
export async function handleActivationDecision(referrerId, decision) {
  const { referrers, kycIdentities } = await getReferralCollections();

  const referrer = await referrers.findOne({ _id: new ObjectId(referrerId) });
  if (!referrer) {
    console.error("referrals/webhook: no referrer found for activation id", referrerId);
    return;
  }

  const now = new Date().toISOString();

  if (!isApproved(decision.status)) {
    if (isTerminalNonApproved(decision.status)) {
      await referrers.updateOne({ _id: referrer._id }, { $set: { status: "rejected", rejectionReason: decision.status, updatedAt: now } });
    }
    return;
  }

  const identity = extractIdentityFromDecision(decision);
  const fingerprint = identity ? computeIdentityFingerprint(identity) : null;
  if (!fingerprint) {
    console.error("referrals/webhook: Approved activation decision had no usable identity fields, session", decision.session_id);
    await referrers.updateOne({ _id: referrer._id }, { $set: { status: "rejected", rejectionReason: "no_identity_data", updatedAt: now } });
    return;
  }

  const priorIdentity = await kycIdentities.findOne({ identityFingerprint: fingerprint });
  if (priorIdentity && priorIdentity.email !== referrer.email) {
    await referrers.updateOne({ _id: referrer._id }, { $set: { status: "rejected", rejectionReason: "duplicate_identity", updatedAt: now } });
    return;
  }

  const referralCode = referrer.referralCode || (await allocateUniqueReferralCode(referrers));

  await Promise.all([
    kycIdentities.updateOne(
      { email: referrer.email },
      { $set: { email: referrer.email, identityFingerprint: fingerprint, verifiedAt: now } },
      { upsert: true }
    ),
    referrers.updateOne(
      { _id: referrer._id },
      { $set: { status: "verified", identityFingerprint: fingerprint, referralCode, verifiedAt: now, updatedAt: now } }
    ),
  ]);
}

async function allocateUniqueReferralCode(referrers) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateReferralCode();
    const clash = await referrers.findOne({ referralCode: code });
    if (!clash) return code;
  }
  throw new Error("Could not allocate a unique referral code after 10 attempts.");
}

// ============================================================
// Referred-person decision -> the actual "successful referral" event
// ============================================================
export async function handleReferralDecision(referralId, decision) {
  const { referrers, referrals, kycIdentities, referralRewards, programCounters } = await getReferralCollections();

  const referral = await referrals.findOne({ _id: new ObjectId(referralId) });
  if (!referral) {
    console.error("referrals/webhook: no referral found for id", referralId);
    return;
  }
  if (referral.status === "verified") return; // already credited, nothing to do

  const now = new Date().toISOString();

  if (!isApproved(decision.status)) {
    if (isTerminalNonApproved(decision.status)) {
      await referrals.updateOne({ _id: referral._id }, { $set: { status: "rejected", rejectionReason: decision.status, updatedAt: now } });
    }
    return;
  }

  const identity = extractIdentityFromDecision(decision);
  const fingerprint = identity ? computeIdentityFingerprint(identity) : null;
  if (!fingerprint) {
    await referrals.updateOne({ _id: referral._id }, { $set: { status: "rejected", rejectionReason: "no_identity_data", updatedAt: now } });
    return;
  }

  // Self-referral: compare against the REFERRER's own verified identity,
  // not email strings.
  const referrerIdentity = await kycIdentities.findOne({ email: referral.referrerEmail });
  if (referrerIdentity && referrerIdentity.identityFingerprint === fingerprint) {
    await referrals.updateOne({ _id: referral._id }, { $set: { status: "rejected", rejectionReason: "self_referral", updatedAt: now } });
    return;
  }

  // Duplicate-identity: this physical document already used under a
  // different email anywhere in the program (farming multiple referredEmail
  // rewards off one real identity).
  const priorIdentity = await kycIdentities.findOne({ identityFingerprint: fingerprint });
  if (priorIdentity && priorIdentity.email !== referral.referredEmail) {
    await referrals.updateOne({ _id: referral._id }, { $set: { status: "rejected", rejectionReason: "duplicate_identity", updatedAt: now } });
    return;
  }

  await kycIdentities.updateOne(
    { email: referral.referredEmail },
    { $set: { email: referral.referredEmail, identityFingerprint: fingerprint, verifiedAt: now } },
    { upsert: true }
  );

  // Atomic cap enforcement: global cap first (the hard stop), then the
  // per-referrer cap; if the per-referrer cap fails after the global
  // counter already incremented, compensate with a rollback. Both go
  // through the same atomicCappedIncrement() helper (src/lib/referrals.js) —
  // safe under concurrent webhook deliveries since each is one atomic
  // findOneAndUpdate.
  const globalResult = await atomicCappedIncrement({
    collection: programCounters,
    filter: { _id: "global" },
    capField: "totalDistributedInaya",
    capLimit: GLOBAL_PROGRAM_CAP_INAYA,
    incFields: { totalDistributedInaya: REWARD_PER_SUCCESSFUL_REFERRAL_INAYA, totalSuccessfulReferrals: 1 },
  });
  if (!globalResult) {
    await referrals.updateOne({ _id: referral._id }, { $set: { status: "rejected", rejectionReason: "global_cap_reached", updatedAt: now } });
    console.error(`referrals/webhook: GLOBAL CAP REACHED, referral ${referralId} not credited.`);
    return;
  }

  const referrerCapResult = await atomicCappedIncrement({
    collection: referrers,
    filter: { email: referral.referrerEmail },
    capField: "successfulReferralCount",
    capLimit: MAX_REFERRALS_PER_REFERRER,
    incFields: { successfulReferralCount: 1 },
  });
  if (!referrerCapResult) {
    // Roll back the global counter we just took.
    await programCounters.updateOne(
      { _id: "global" },
      { $inc: { totalDistributedInaya: -REWARD_PER_SUCCESSFUL_REFERRAL_INAYA, totalSuccessfulReferrals: -1 } }
    );
    await referrals.updateOne({ _id: referral._id }, { $set: { status: "rejected", rejectionReason: "referrer_cap_reached", updatedAt: now } });
    return;
  }

  await Promise.all([
    referralRewards.insertOne({
      user: referral.referrerEmail,
      role: "referrer",
      amount: REWARD_REFERRER_INAYA,
      referralId: referral._id,
      recordedAt: now,
      distributedAt: null,
      claimWalletAddress: null,
    }),
    referralRewards.insertOne({
      user: referral.referredEmail,
      role: "referred",
      amount: REWARD_REFERRED_INAYA,
      referralId: referral._id,
      recordedAt: now,
      distributedAt: null,
      claimWalletAddress: null,
    }),
    referrals.updateOne({ _id: referral._id }, { $set: { status: "verified", creditedAt: now, updatedAt: now } }),
  ]);
}
