// app/api/referrals/leaderboard/route.js
//
// GET /api/referrals/leaderboard — Top 50 referrers ranked strictly by
// successful-referral count (no points system, no counting unverified/
// pending/failed referrals — successfulReferralCount is only ever
// incremented in the webhook's atomic crediting step, so it's already
// exactly that count by construction).
//
// The actual query/sort/mask logic is getLeaderboardEntries() in
// ../../../../lib/referrals.js — factored out so it's unit-testable without
// importing next/server (see that function's comment for why).

import { NextResponse } from "next/server";
import { getReferralCollections, getLeaderboardEntries } from "../../../../lib/referrals.js";

export async function GET() {
  try {
    const { referrers } = await getReferralCollections();
    const leaderboard = await getLeaderboardEntries(referrers);
    return NextResponse.json({ leaderboard });
  } catch (err) {
    console.error("referrals/leaderboard failed:", err);
    return NextResponse.json({ error: "Could not fetch leaderboard." }, { status: 500 });
  }
}
