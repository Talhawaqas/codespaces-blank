// app/api/nodes/operator/fleet/route.js
//
// GET /api/nodes/operator/fleet — SOW §15's fleet view, only meaningful
// once the session has linked at least one additional wallet (see
// POST /link). Aggregates the exact same getNodeOperatorSummary() used by
// GET /me, once per wallet (primary + linked) -- no separate fleet-only
// query logic to drift from the single-node view.

import { NextResponse } from "next/server";
import { requireNodeSession } from "../../../../../lib/nodeOperatorAuth.js";
import { getNodeOperatorSummary } from "../../../../../lib/nodeOperatorSummary.js";

export async function GET(req) {
  try {
    const session = await requireNodeSession(req);
    if (session.error) return NextResponse.json({ error: session.error }, { status: session.status });

    const wallets = [session.walletAddress, ...session.linkedWallets];
    const summaries = await Promise.all(wallets.map((w) => getNodeOperatorSummary(w)));

    const rows = wallets.map((wallet, i) => ({ wallet, ...summaries[i] }));
    const healthy = rows.filter((r) => r.status === "healthy").length;
    const offline = rows.filter((r) => r.status === "offline").length;
    const degraded = rows.filter((r) => r.status === "degraded").length;
    const uptimeScores = rows.map((r) => r.telemetry?.uptimeScoreBps).filter((v) => typeof v === "number");

    return NextResponse.json({
      totalNodes: rows.length,
      onlineNodes: healthy + degraded,
      offlineNodes: offline,
      degradedNodes: degraded,
      averageUptimeBps: uptimeScores.length ? Math.round(uptimeScores.reduce((s, v) => s + v, 0) / uptimeScores.length) : null,
      lowestUptimeBps: uptimeScores.length ? Math.min(...uptimeScores) : null,
      highestUptimeBps: uptimeScores.length ? Math.max(...uptimeScores) : null,
      nodes: rows,
    });
  } catch (err) {
    console.error("nodes/operator/fleet GET failed:", err);
    return NextResponse.json({ error: "Could not load fleet summary." }, { status: 500 });
  }
}
