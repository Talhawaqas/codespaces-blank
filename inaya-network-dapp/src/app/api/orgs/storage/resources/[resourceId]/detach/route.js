// app/api/orgs/storage/resources/[resourceId]/detach/route.js
// POST { orgId } -> release the reservation/lock

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { detachVolume } from "../../../../../../../lib/storageResources.js";

export async function POST(req, { params }) {
  try {
    const { resourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await detachVolume({ orgId, resourceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/resources/[resourceId]/detach POST failed:", err);
    return NextResponse.json({ error: "Could not detach volume." }, { status: 500 });
  }
}
