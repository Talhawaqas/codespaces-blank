// app/api/referrals/redeem/route.js
//
// POST /api/referrals/redeem
// Body: { referralCode, referredEmail }
//
// The self-serve counterpart to /api/referrals/initiate: instead of the
// referrer typing in the referred person's email themselves, the referrer
// shares a public link (https://.../?ref=CODE) and whoever clicks it enters
// their OWN email here. Same underlying `referrals` doc/session creation
// and the same fraud checks apply once the webhook comes back — this route
// only differs in how the referrer is identified (by code, not by them
// submitting the invite directly).

import { NextResponse } from "next/server";
import { createDiditSession } from "../../../../lib/didit.js";
import { enforceRiskGate, RISK_GATE_REJECTION } from "../../../../lib/riskGate.js";
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
    const { referralCode, referredEmail: rawReferred } = await req.json();
    const code = String(referralCode || "").trim().toUpperCase();
    const referredEmail = normalizeEmail(rawReferred);

    if (!code || !referredEmail || !isValidEmail(referredEmail)) {
      return NextResponse.json({ error: "A valid referral code and email are required." }, { status: 400 });
    }

    // Phase 2 of the Fraud & Abuse Protection Layer. This is the more
    // Sybil-prone of the two referral entry points -- a public link where
    // one IP can attempt many different emails -- but the gate is
    // identical: only rejects at RESTRICT/TEMPORARILY_BLOCK, which
    // requires a CONFIRMED reputation signal, never VPN detection alone.
    const risk = await enforceRiskGate({ req, identityId: referredEmail, surface: "referral" });
    if (!risk.allowed) {
      return NextResponse.json({ error: RISK_GATE_REJECTION.error }, { status: RISK_GATE_REJECTION.status });
    }

    await ensureReferralIndexes();
    const { referrers, referrals, programCounters } = await getReferralCollections();

    const referrer = await referrers.findOne({ referralCode: code, status: "verified" });
    if (!referrer) {
      return NextResponse.json({ error: "That referral code isn't valid." }, { status: 404 });
    }
    if (referrer.email === referredEmail) {
      return NextResponse.json({ error: "You can't redeem your own referral link." }, { status: 400 });
    }
    if (referrer.successfulReferralCount >= MAX_REFERRALS_PER_REFERRER) {
      return NextResponse.json({ error: "This referrer has reached their referral limit." }, { status: 403 });
    }

    const counters = await programCounters.findOne({ _id: "global" });
    const totalDistributed = counters?.totalDistributedInaya || 0;
    if (totalDistributed + REWARD_PER_SUCCESSFUL_REFERRAL_INAYA > GLOBAL_PROGRAM_CAP_INAYA) {
      return NextResponse.json({ error: "The referral program has reached its total reward cap." }, { status: 403 });
    }

    const referrerEmail = referrer.email;
    const existingReferral = await referrals.findOne({ referrerEmail, referredEmail });
    if (existingReferral?.status === "verified") {
      return NextResponse.json({ error: "You've already completed a referral with this code." }, { status: 409 });
    }
    if (existingReferral?.status === "pending" && existingReferral.diditSessionUrl) {
      return NextResponse.json({ status: "pending", url: existingReferral.diditSessionUrl, referralId: existingReferral._id.toString() });
    }

    const now = new Date().toISOString();
    await referrals.updateOne(
      { referrerEmail, referredEmail },
      { $setOnInsert: { referrerEmail, referredEmail, status: "pending", createdAt: now, viaCode: code } },
      { upsert: true }
    );
    const referralDoc = await referrals.findOne({ referrerEmail, referredEmail });

    const session = await createDiditSession({ vendorData: `referral:${referralDoc._id.toString()}` });

    await referrals.updateOne(
      { _id: referralDoc._id },
      { $set: { diditSessionId: session.sessionId, diditSessionUrl: session.url, status: "pending", updatedAt: now } }
    );

    return NextResponse.json({ status: "pending", url: session.url, referralId: referralDoc._id.toString() });
  } catch (err) {
    console.error("referrals/redeem failed:", err);
    return NextResponse.json({ error: "Could not start verification. Please try again." }, { status: 500 });
  }
}
