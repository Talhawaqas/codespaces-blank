// app/api/referrals/initiate/route.js
//
// POST /api/referrals/initiate
// Body: { referrerEmail, referredEmail }
//
// Requires the referrer to have already completed /api/referrals/activate
// (status "verified" — a real Didit KYC pass, not just an email). Creates
// (or reuses) a `referrals` doc for this (referrer, referred) pair and a
// Didit KYC session for the REFERRED person. The heavier fraud checks
// (self-referral by identity, duplicate-identity, cap enforcement) happen
// in the webhook once the referred person's KYC actually comes back —
// this route only does the cheap, immediate checks (email-level
// self-referral, cap headroom) that are worth failing fast on.

import { NextResponse } from "next/server";
import { createDiditSession } from "../../../../lib/didit.js";
import {
  getReferralCollections,
  ensureReferralIndexes,
  normalizeEmail,
  isValidEmail,
  MAX_REFERRALS_PER_REFERRER,
  GLOBAL_PROGRAM_CAP_INAYA,
  REWARD_PER_SUCCESSFUL_REFERRAL_INAYA,
} from "../../../../lib/referrals.js";

export const dynamic = 'force-dynamic';
export async function POST(req) {
  try {
    const { referrerEmail: rawReferrer, referredEmail: rawReferred } = await req.json();
    const referrerEmail = normalizeEmail(rawReferrer);
    const referredEmail = normalizeEmail(rawReferred);

    if (!referrerEmail || !isValidEmail(referrerEmail) || !referredEmail || !isValidEmail(referredEmail)) {
      return NextResponse.json({ error: "A valid referrer and referred email are both required." }, { status: 400 });
    }
    // Cheap first-line check. The real, unspoofable check (verified-identity
    // comparison) happens in the webhook once the referred person's KYC
    // decision is in — this just blocks the trivial "same address twice" case fast.
    if (referrerEmail === referredEmail) {
      return NextResponse.json({ error: "You can't refer your own email address." }, { status: 400 });
    }

    await ensureReferralIndexes();
    const { referrers, referrals, programCounters } = await getReferralCollections();

    const referrer = await referrers.findOne({ email: referrerEmail });
    if (!referrer || referrer.status !== "verified") {
      return NextResponse.json({ error: "Complete your own verification first — see /api/referrals/activate." }, { status: 403 });
    }
    if (referrer.successfulReferralCount >= MAX_REFERRALS_PER_REFERRER) {
      return NextResponse.json({ error: `You've reached the maximum of ${MAX_REFERRALS_PER_REFERRER} successful referrals.` }, { status: 403 });
    }

    const counters = await programCounters.findOne({ _id: "global" });
    const totalDistributed = counters?.totalDistributedInaya || 0;
    if (totalDistributed + REWARD_PER_SUCCESSFUL_REFERRAL_INAYA > GLOBAL_PROGRAM_CAP_INAYA) {
      return NextResponse.json({ error: "The referral program has reached its total reward cap." }, { status: 403 });
    }

    const existingReferral = await referrals.findOne({ referrerEmail, referredEmail });
    if (existingReferral?.status === "verified") {
      return NextResponse.json({ error: "This person has already completed a referral with you." }, { status: 409 });
    }
    if (existingReferral?.status === "pending" && existingReferral.diditSessionUrl) {
      return NextResponse.json({
        status: "pending",
        url: existingReferral.diditSessionUrl,
        referralCode: referrer.referralCode,
        referralId: existingReferral._id.toString(),
      });
    }

    const now = new Date().toISOString();
    await referrals.updateOne(
      { referrerEmail, referredEmail },
      { $setOnInsert: { referrerEmail, referredEmail, status: "pending", createdAt: now } },
      { upsert: true }
    );
    const referralDoc = await referrals.findOne({ referrerEmail, referredEmail });

    const session = await createDiditSession({ vendorData: `referral:${referralDoc._id.toString()}` });

    await referrals.updateOne(
      { _id: referralDoc._id },
      { $set: { diditSessionId: session.sessionId, diditSessionUrl: session.url, status: "pending", updatedAt: now } }
    );

    return NextResponse.json({ status: "pending", url: session.url, referralCode: referrer.referralCode, referralId: referralDoc._id.toString() });
  } catch (err) {
    console.error("referrals/initiate failed:", err);
    return NextResponse.json({ error: "Could not start the referral. Please try again." }, { status: 500 });
  }
}
