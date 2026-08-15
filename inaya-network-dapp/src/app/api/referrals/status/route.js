// app/api/referrals/status/route.js
//
// GET /api/referrals/status?email=...            -> referrer's own activation status
// GET /api/referrals/status?referralId=...        -> a specific referral's status
//
// Polling fallback for the frontend while waiting on the webhook (e.g. if
// a user closes the KYC tab and comes back later) — also directly usable
// to render the "pending / verified / rejected" messaging the SOW asks for.

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getReferralCollections, ensureReferralIndexes, normalizeEmail } from "../../../../lib/referrals.js";
import { getDiditDecision } from "../../../../lib/didit.js";
import { handleActivationDecision, handleReferralDecision } from "../../../../lib/referral-webhook-logic.js";

export const dynamic = 'force-dynamic';

// Reconciliation fallback for a webhook that never arrived or was rejected
// (e.g. delivered past the signature freshness window) — this endpoint is
// polled by the frontend while status is "pending" anyway, so it's a
// natural place to double-check Didit's own live decision and self-heal a
// stuck record before answering, using the EXACT SAME crediting logic the
// webhook itself uses (handleActivationDecision/handleReferralDecision) so
// there's no separate, divergent code path for this vs. the webhook.
// Best-effort: a Didit API hiccup here just means we fall back to
// returning whatever the DB currently has, not a hard failure.
async function reconcilePendingReferrer(referrer) {
  if (referrer.status !== "pending" || !referrer.diditSessionId) return referrer;
  try {
    const decision = await getDiditDecision(referrer.diditSessionId);
    await handleActivationDecision(referrer._id.toString(), decision);
  } catch (err) {
    console.error("referrals/status: reconciliation against Didit failed for referrer", referrer._id.toString(), err);
    return referrer;
  }
  const { referrers } = await getReferralCollections();
  return (await referrers.findOne({ _id: referrer._id })) || referrer;
}

async function reconcilePendingReferral(referral) {
  if (referral.status !== "pending" || !referral.diditSessionId) return referral;
  try {
    const decision = await getDiditDecision(referral.diditSessionId);
    await handleReferralDecision(referral._id.toString(), decision);
  } catch (err) {
    console.error("referrals/status: reconciliation against Didit failed for referral", referral._id.toString(), err);
    return referral;
  }
  const { referrals } = await getReferralCollections();
  return (await referrals.findOne({ _id: referral._id })) || referral;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const email = normalizeEmail(searchParams.get("email") || "");
    const referralId = searchParams.get("referralId");

    if (!email && !referralId) {
      return NextResponse.json({ error: "email or referralId is required." }, { status: 400 });
    }

    await ensureReferralIndexes();
    const { referrers, referrals } = await getReferralCollections();

    if (referralId) {
      if (!ObjectId.isValid(referralId)) {
        return NextResponse.json({ error: "Invalid referralId." }, { status: 400 });
      }
      let referral = await referrals.findOne({ _id: new ObjectId(referralId) });
      if (!referral) return NextResponse.json({ error: "Referral not found." }, { status: 404 });
      referral = await reconcilePendingReferral(referral);
      return NextResponse.json({
        status: referral.status,
        rejectionReason: referral.rejectionReason || null,
        referredEmail: referral.referredEmail,
        createdAt: referral.createdAt,
        creditedAt: referral.creditedAt || null,
      });
    }

    let referrer = await referrers.findOne({ email });
    if (!referrer) return NextResponse.json({ status: "not_started" });
    referrer = await reconcilePendingReferrer(referrer);
    return NextResponse.json({
      status: referrer.status,
      rejectionReason: referrer.rejectionReason || null,
      referralCode: referrer.referralCode || null,
      successfulReferralCount: referrer.successfulReferralCount || 0,
    });
  } catch (err) {
    console.error("referrals/status failed:", err);
    return NextResponse.json({ error: "Could not fetch status." }, { status: 500 });
  }
}
