// app/api/referrals/history/route.js
//
// GET /api/referrals/history?email=... -> a referrer's own referral list +
// running INAYA total. Auth model is intentionally the same as the rest of
// this feature: email only, no wallet, no password — consistent with the
// SOW's "no wallet required" design. This means anyone who knows an email
// can view its referral history/totals (not funds — this is accounting
// only, real distribution is a separate future claim process). If that
// trust level ever needs tightening, a magic-link email verification step
// would slot in here without touching the schema.

import { NextResponse } from "next/server";
import { getReferralCollections, normalizeEmail } from "../../../../lib/referrals.js";

export const dynamic = 'force-dynamic';
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const email = normalizeEmail(searchParams.get("email") || "");
    if (!email) return NextResponse.json({ error: "email is required." }, { status: 400 });

    const { referrers, referrals, referralRewards } = await getReferralCollections();

    const [referrer, referralList, rewards] = await Promise.all([
      referrers.findOne({ email }),
      referrals
        .find({ referrerEmail: email })
        .sort({ createdAt: -1 })
        .project({ referredEmail: 1, status: 1, createdAt: 1, creditedAt: 1 })
        .toArray(),
      referralRewards.find({ user: email }).toArray(),
    ]);

    const totalInayaEarned = rewards.reduce((sum, r) => sum + r.amount, 0);

    return NextResponse.json({
      referrerStatus: referrer?.status || "not_started",
      referralCode: referrer?.referralCode || null,
      successfulReferralCount: referrer?.successfulReferralCount || 0,
      totalInayaEarned,
      referrals: referralList.map((r) => ({
        referredEmail: r.referredEmail,
        status: r.status,
        createdAt: r.createdAt,
        creditedAt: r.creditedAt || null,
      })),
    });
  } catch (err) {
    console.error("referrals/history failed:", err);
    return NextResponse.json({ error: "Could not fetch history." }, { status: 500 });
  }
}
