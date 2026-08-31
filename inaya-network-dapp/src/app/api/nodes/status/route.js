// app/api/nodes/status/route.js
//
// GET /api/nodes/status?nodeId= — public, self-serve status check for a
// node operator's own daemon (backs the new "inaya-node-daemon status"
// CLI command). Combines the storage-telemetry doc (nodes collection —
// capacity, uptimeScoreBps, daemon version/uptime/restarts/last error)
// with the threat-reporting reputation snapshot (security.js's
// getReputationSnapshot — same data /api/security/reputation/:address
// already exposes) into one call, since an operator checking on their
// own node cares about both halves of Phase 5 at once.

import { NextResponse } from "next/server";
import clientPromise from "../../../../lib/mongodb";
import { ensureSecurityIndexes, getReputationSnapshot } from "../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const nodeId = req.nextUrl.searchParams.get("nodeId");
    if (!nodeId) return NextResponse.json({ error: "nodeId is required." }, { status: 400 });

    const client = await clientPromise;
    const db = client.db("inaya_network");
    const node = await db.collection("nodes").findOne({ nodeId: nodeId.toLowerCase() });
    if (!node) return NextResponse.json({ error: "This node hasn't sent a heartbeat yet." }, { status: 404 });

    await ensureSecurityIndexes();
    const reputation = await getReputationSnapshot(nodeId);

    return NextResponse.json({
      nodeId: node.nodeId,
      totalCapacityGB: node.totalCapacityGB ?? 0,
      usedCapacityGB: node.usedCapacityGB ?? 0,
      shardsStored: node.shardsStored ?? 0,
      lastHeartbeatAt: node.lastHeartbeatAt,
      uptimeScoreBps: node.uptimeScoreBps ?? null,
      daemonVersion: node.daemonVersion ?? null,
      daemonUptimeSeconds: node.uptimeSeconds ?? null,
      restartCount: node.restartCount ?? null,
      lastErrorAt: node.lastErrorAt ?? null,
      lastErrorMessage: node.lastErrorMessage ?? null,
      threatReporting: {
        scoreBps: reputation.scoreBps,
        totalConfirmed: reputation.totalConfirmed,
        totalFalsePositive: reputation.totalFalsePositive,
        confirmationRate: reputation.totalConfirmed + reputation.totalFalsePositive > 0
          ? Math.round((reputation.totalConfirmed / (reputation.totalConfirmed + reputation.totalFalsePositive)) * 10000)
          : null,
        checkpointed: reputation.checkpointed,
      },
    });
  } catch (err) {
    console.error("nodes/status GET failed:", err);
    return NextResponse.json({ error: "Could not load node status." }, { status: 500 });
  }
}
