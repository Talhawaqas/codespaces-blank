// app/api/orgs/storage/nodes/route.js
//
// GET  /api/orgs/storage/nodes?orgId=
// POST /api/orgs/storage/nodes  { orgId, nodeWallet, capacityGB }
// Enterprise-owned storage node control plane — registration + listing
// only. Actual shard routing is NOT enabled; see storage-manager.js's
// header comment.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageStorage, canAccessStorage } from "../../../../../lib/orgs.js";
import { registerOrgStorageNode, listOrgStorageNodes } from "../../../../../lib/storage-manager.js";

function serialize(n) {
  return {
    id: n._id.toString(), nodeWallet: n.nodeWallet, capacityGB: n.capacityGB, status: n.status,
    eligibility: n.eligibility, registeredAt: n.registeredAt, lastHeartbeatAt: n.lastHeartbeatAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessStorage(auth.membership)) return NextResponse.json({ error: "You don't have storage-infrastructure access." }, { status: 403 });

    const nodes = await listOrgStorageNodes(orgId);
    return NextResponse.json({ nodes: nodes.map(serialize) });
  } catch (err) {
    console.error("orgs/storage/nodes GET failed:", err);
    return NextResponse.json({ error: "Could not fetch storage nodes." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, nodeWallet, capacityGB } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageStorage(auth.membership)) return NextResponse.json({ error: "Only a storage manager can register a node." }, { status: 403 });

    const result = await registerOrgStorageNode({ orgId, nodeWallet, capacityGB, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ nodeId: result.nodeId.toString() });
  } catch (err) {
    console.error("orgs/storage/nodes POST failed:", err);
    return NextResponse.json({ error: "Could not register the storage node." }, { status: 500 });
  }
}
