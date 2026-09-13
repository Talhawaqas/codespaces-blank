// app/api/orgs/storage/nodes/[nodeId]/health/route.js
//
// POST /api/orgs/storage/nodes/:nodeId/health  { orgId, capacityGB?, healthy }
// A registered node's own operator reports health/capacity. No daemon
// calls this automatically yet (org-scoped nodes have no live telemetry
// pipeline today) -- see storage-manager.js's header comment.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessStorage } from "../../../../../../../lib/orgs.js";
import { reportOrgStorageNodeHealth } from "../../../../../../../lib/storage-manager.js";

export async function POST(req, { params }) {
  try {
    const { nodeId } = params;
    const { orgId, capacityGB, healthy } = await req.json();
    if (!orgId || typeof healthy !== "boolean") return NextResponse.json({ error: "orgId and a boolean healthy flag are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessStorage(auth.membership)) return NextResponse.json({ error: "You don't have storage-infrastructure access." }, { status: 403 });

    const result = await reportOrgStorageNodeHealth({ orgId, nodeId, capacityGB, healthy });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ status: result.node.status, lastHeartbeatAt: result.node.lastHeartbeatAt });
  } catch (err) {
    console.error("orgs/storage/nodes/[nodeId]/health POST failed:", err);
    return NextResponse.json({ error: "Could not report node health." }, { status: 500 });
  }
}
