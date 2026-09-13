// app/api/nodes/operator/rewards/route.js
//
// GET /api/nodes/operator/rewards — tier/commission + settlement status,
// combining nodeChainReads.js's two on-chain reads. Read-only: there is no
// claim/release action here, because releasing an unlocked settlement is
// already fully automated by the existing cron
// (api/nodes/settlements/release/route.js) -- this route can only ever
// show what that timelock allows, never bypass it.

import { NextResponse } from "next/server";
import { requireNodeSession } from "../../../../../lib/nodeOperatorAuth.js";
import { getOnChainNodeInfo, getSettlementsForOperator } from "../../../../../lib/nodeChainReads.js";

export async function GET(req) {
  try {
    const session = await requireNodeSession(req);
    if (session.error) return NextResponse.json({ error: session.error }, { status: session.status });

    const [onChain, settlements] = await Promise.all([
      getOnChainNodeInfo(session.walletAddress),
      getSettlementsForOperator(session.walletAddress),
    ]);

    if (!onChain.isRegistered) {
      return NextResponse.json({
        available: false,
        reason: onChain.error || "This wallet isn't registered on-chain yet — rewards aren't active for it.",
      });
    }

    return NextResponse.json({
      available: true,
      tier: onChain.tier,
      commissionPct: onChain.commissionPct,
      totalEarnedUsdt: onChain.totalEarnedUsdt,
      settlements: settlements.map((s) => ({
        amount: s.amount,
        unlockTime: new Date(s.unlockTime * 1000).toISOString(),
        released: s.released,
        isClaimable: s.isClaimable,
        secondsRemaining: s.secondsRemaining,
      })),
    });
  } catch (err) {
    console.error("nodes/operator/rewards GET failed:", err);
    return NextResponse.json({ error: "Could not load rewards status." }, { status: 500 });
  }
}
