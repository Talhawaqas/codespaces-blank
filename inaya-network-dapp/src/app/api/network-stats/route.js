// app/api/network-stats/route.js
//
// GET /api/network-stats -> public, aggregated, real-time social-proof
// numbers for the /stats page. Every figure here reuses an aggregation
// function that already exists and is already trusted elsewhere
// (getPublicSecurityStats powers /security's own live stats;
// getAllActiveUserStats powers the admin dashboard's Active Users
// section) -- nothing new is invented, this route just combines them
// and adds one small referral-program aggregate on top.

import { NextResponse } from "next/server";
import { getPublicSecurityStats } from "../../../lib/security.js";
import { getAllActiveUserStats } from "../../../lib/activity.js";
import { getReferralCollections } from "../../../lib/referrals.js";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const { referrers, referralRewards } = await getReferralCollections();

    const [security, activity, verifiedReferrersCount, rewardDocs] = await Promise.all([
      getPublicSecurityStats(),
      getAllActiveUserStats(),
      referrers.countDocuments({ status: "verified" }),
      referralRewards.find({}, { projection: { amount: 1 } }).toArray(),
    ]);

    const totalInayaDistributed = rewardDocs.reduce((sum, r) => sum + (r.amount || 0), 0);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      activeUsers: activity,
      security,
      community: {
        verifiedReferrersCount,
        totalInayaDistributed: Math.round(totalInayaDistributed * 100) / 100,
      },
    });
  } catch (err) {
    console.error("network-stats failed:", err);
    return NextResponse.json({ error: "Could not load network stats." }, { status: 500 });
  }
}
