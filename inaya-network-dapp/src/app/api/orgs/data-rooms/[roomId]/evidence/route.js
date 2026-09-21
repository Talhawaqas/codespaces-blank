// app/api/orgs/data-rooms/[roomId]/evidence/route.js
//
// GET /api/orgs/data-rooms/:roomId/evidence?orgId= -> a read-only,
// cryptographically-hashed evidence package for this room (Modular
// Enterprise Adoption Features SOW §7.7).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { exportDataRoomEvidence } from "../../../../../../lib/dataRoomEvidence.js";

export async function GET(req, { params }) {
  try {
    const { roomId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await exportDataRoomEvidence({ orgId, roomId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-rooms/[roomId]/evidence GET failed:", err);
    return NextResponse.json({ error: "Could not export evidence for this room." }, { status: 500 });
  }
}
