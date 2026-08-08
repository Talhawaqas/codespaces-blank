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
      const referral = await referrals.findOne({ _id: new ObjectId(referralId) });
      if (!referral) return NextResponse.json({ error: "Referral not found." }, { status: 404 });
      return NextResponse.json({
        status: referral.status,
        rejectionReason: referral.rejectionReason || null,
        referredEmail: referral.referredEmail,
        createdAt: referral.createdAt,
        creditedAt: referral.creditedAt || null,
      });
    }

    const referrer = await referrers.findOne({ email });
    if (!referrer) return NextResponse.json({ status: "not_started" });
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
