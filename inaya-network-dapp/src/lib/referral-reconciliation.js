// src/lib/referral-reconciliation.js
//
// Shared by GET /api/referrals/status (single-record polling) and
// GET /api/referrals/history (a referrer's full list) — factored out so
// both surfaces self-heal a stuck "pending" record the same way, rather
// than history silently showing a referral that can never resolve while
// status's own polling would have caught it.

import { getReferralCollections } from "./referrals.js";
import { getDiditDecision, DiditSessionNotFoundError } from "./didit.js";
import { handleActivationDecision, handleReferralDecision } from "./referral-webhook-logic.js";

// A record only lacks a diditSessionId while /api/referrals/activate (or
// initiate/redeem) is still mid-request between inserting the "pending" doc
// and saving the session it just created — normally milliseconds. Past this
// window, the session creation call itself must have failed (Didit outage,
// rate limit, timeout), leaving the record permanently unreconcilable: it
// has nothing to check, so it would otherwise sit at "pending" forever with
// no path forward.
const SESSION_MISSING_GRACE_MS = 2 * 60 * 1000;

// Every reason a record can land back in "rejected" that ISN'T a real Didit
// decision — these are what let a user reapply via the exact same "Start
// verification" button /activate, /initiate, and /redeem already resume
// cleanly from a rejected record (fresh session, status reset to pending).
// Reusing "rejected" here (rather than inventing new statuses) means the
// frontend's existing rejected-state UI IS the reapply mechanism, with no
// new code path to keep in sync.
export const REASON_SESSION_EXPIRED = "session_expired";
export const REASON_NOT_STARTED = "verification_not_started";

// Reconciliation fallback for a webhook that never arrived or was rejected
// (e.g. delivered past the signature freshness window) — also the place
// that double-checks Didit's own live decision and self-heals a stuck
// record, using the EXACT SAME crediting logic the webhook itself uses
// (handleActivationDecision/handleReferralDecision) so there's no separate,
// divergent code path for this vs. the webhook.
// Best-effort: a transient Didit API hiccup here just falls back to
// returning whatever the DB currently has — only a DEFINITIVE dead-end
// (session 404, or no session ever created) flips status to "rejected".
export async function reconcilePendingReferrer(referrer) {
  if (referrer.status !== "pending") return referrer;
  const { referrers } = await getReferralCollections();

  if (!referrer.diditSessionId) {
    const ageMs = Date.now() - new Date(referrer.createdAt).getTime();
    if (ageMs < SESSION_MISSING_GRACE_MS) return referrer;
    await referrers.updateOne(
      { _id: referrer._id },
      { $set: { status: "rejected", rejectionReason: REASON_NOT_STARTED, updatedAt: new Date().toISOString() } }
    );
    return (await referrers.findOne({ _id: referrer._id })) || referrer;
  }

  try {
    const decision = await getDiditDecision(referrer.diditSessionId);
    await handleActivationDecision(referrer._id.toString(), decision);
  } catch (err) {
    if (err instanceof DiditSessionNotFoundError) {
      await referrers.updateOne(
        { _id: referrer._id },
        { $set: { status: "rejected", rejectionReason: REASON_SESSION_EXPIRED, updatedAt: new Date().toISOString() } }
      );
    } else {
      console.error("referral-reconciliation: Didit check failed for referrer", referrer._id.toString(), err);
    }
    return (await referrers.findOne({ _id: referrer._id })) || referrer;
  }
  return (await referrers.findOne({ _id: referrer._id })) || referrer;
}

export async function reconcilePendingReferral(referral) {
  if (referral.status !== "pending") return referral;
  const { referrals } = await getReferralCollections();

  if (!referral.diditSessionId) {
    const ageMs = Date.now() - new Date(referral.createdAt).getTime();
    if (ageMs < SESSION_MISSING_GRACE_MS) return referral;
    await referrals.updateOne(
      { _id: referral._id },
      { $set: { status: "rejected", rejectionReason: REASON_NOT_STARTED, updatedAt: new Date().toISOString() } }
    );
    return (await referrals.findOne({ _id: referral._id })) || referral;
  }

  try {
    const decision = await getDiditDecision(referral.diditSessionId);
    await handleReferralDecision(referral._id.toString(), decision);
  } catch (err) {
    if (err instanceof DiditSessionNotFoundError) {
      await referrals.updateOne(
        { _id: referral._id },
        { $set: { status: "rejected", rejectionReason: REASON_SESSION_EXPIRED, updatedAt: new Date().toISOString() } }
      );
    } else {
      console.error("referral-reconciliation: Didit check failed for referral", referral._id.toString(), err);
    }
    return (await referrals.findOne({ _id: referral._id })) || referral;
  }
  return (await referrals.findOne({ _id: referral._id })) || referral;
}
