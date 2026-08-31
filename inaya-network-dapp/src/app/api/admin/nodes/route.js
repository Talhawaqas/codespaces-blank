// app/api/admin/nodes/route.js
//
// GET /api/admin/nodes — admin-only. Storage-node telemetry (capacity,
// uptimeScoreBps, daemon version/restarts/last error) — distinct from
// /api/admin/security/nodes, which is the separate threat-reporting
// reputation view. This is the operator-visibility gap Phase 5's research
// pass confirmed: no admin page previously surfaced the `nodes` collection
// at all.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth.js";
import clientPromise from "../../../../lib/mongodb";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const client = await clientPromise;
    const db = client.db("inaya_network");
    const nodes = await db.collection("nodes").find({}).sort({ lastHeartbeatAt: -1 }).limit(500).toArray();
    return NextResponse.json({
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId, operatorWallet: n.operatorWallet || null,
        totalCapacityGB: n.totalCapacityGB ?? 0, usedCapacityGB: n.usedCapacityGB ?? 0, shardsStored: n.shardsStored ?? 0,
        lastHeartbeatAt: n.lastHeartbeatAt || null, uptimeScoreBps: n.uptimeScoreBps ?? null,
        daemonVersion: n.daemonVersion || null, daemonUptimeSeconds: n.uptimeSeconds ?? null, restartCount: n.restartCount ?? null,
        lastErrorAt: n.lastErrorAt || null, lastErrorMessage: n.lastErrorMessage || null,
      })),
    });
  } catch (err) {
    console.error("admin/nodes GET failed:", err);
    return NextResponse.json({ error: "Could not load node telemetry." }, { status: 500 });
  }
}
