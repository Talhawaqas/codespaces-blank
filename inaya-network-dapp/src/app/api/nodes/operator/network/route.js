// app/api/nodes/operator/network/route.js
//
// GET /api/nodes/operator/network — no session required (SOW §14: public/
// operator-level network context, clearly distinguished from personal
// stats, never another operator's private info). Returns only aggregate
// counts -- no wallet addresses, no per-node telemetry -- adapted from the
// same 'nodes' collection admin/dashboard/route.js's getNodeOperatorStats()
// already reads, but with everything per-operator stripped.
//
// Tier distribution here uses the off-chain `tier` field (set once at
// registration) rather than an on-chain read per node -- reading every
// node's on-chain record on every public page load doesn't scale the way
// a single per-operator read does (see nodeChainReads.js). This is
// explicitly a rough distribution, not the authoritative per-operator tier
// GET /me and /fleet already provide from the chain.

import { NextResponse } from "next/server";
import clientPromise from "../../../../../lib/mongodb.js";
import { isNodeOnline } from "../../../../../lib/nodeUptimeHistory.js";

const EXPECTED_DAEMON_VERSION = process.env.INAYA_EXPECTED_NODE_DAEMON_VERSION || "0.1.0";

export async function GET() {
  try {
    const client = await clientPromise;
    const nodes = client.db("inaya_network").collection("nodes");
    const rows = await nodes.find({}, { projection: { tier: 1, lastHeartbeatAt: 1 } }).toArray();

    const tierDistribution = { Entry: 0, Mid: 0, Enterprise: 0 };
    let activeCount = 0;
    for (const n of rows) {
      const tier = tierDistribution[n.tier] !== undefined ? n.tier : "Entry";
      tierDistribution[tier] += 1;
      if (isNodeOnline(n.lastHeartbeatAt)) activeCount += 1;
    }

    return NextResponse.json({
      totalRegisteredNodes: rows.length,
      activeNodes: activeCount,
      tierDistribution,
      expectedDaemonVersion: EXPECTED_DAEMON_VERSION,
      networkStage: "testnet",
    });
  } catch (err) {
    console.error("nodes/operator/network GET failed:", err);
    return NextResponse.json({ error: "Could not load network information." }, { status: 500 });
  }
}
