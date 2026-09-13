// app/api/nodes/operator/qualification/route.js
//
// GET /api/nodes/operator/qualification — the 90-day / 95%-uptime tracker
// from SOW §8. Thin wrapper over nodeUptimeHistory.js's
// getQualificationStatus(), scoped to the session's own wallet.

import { NextResponse } from "next/server";
import { requireNodeSession } from "../../../../../lib/nodeOperatorAuth.js";
import { getQualificationStatus } from "../../../../../lib/nodeUptimeHistory.js";

export async function GET(req) {
  try {
    const session = await requireNodeSession(req);
    if (session.error) return NextResponse.json({ error: session.error }, { status: session.status });

    const result = await getQualificationStatus(session.walletAddress);
    return NextResponse.json(result);
  } catch (err) {
    console.error("nodes/operator/qualification GET failed:", err);
    return NextResponse.json({ error: "Could not load qualification status." }, { status: 500 });
  }
}
