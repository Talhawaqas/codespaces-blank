// app/api/orgs/storage/snapshots/[snapshotId]/copy/route.js
// POST { orgId, destinationResourceId } -> copy a snapshot's data into another
// resource (a different logical region label, not physical geography -- see
// storageSnapshots.js's own module header)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { copySnapshotToResource } from "../../../../../../../lib/storageSnapshots.js";

export async function POST(req, { params }) {
  try {
    const { snapshotId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, destinationResourceId } = body;
    if (!orgId || !destinationResourceId) return NextResponse.json({ error: "orgId and destinationResourceId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await copySnapshotToResource({ orgId, snapshotId, destinationResourceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/snapshots/[snapshotId]/copy POST failed:", err);
    return NextResponse.json({ error: "Could not copy snapshot." }, { status: 500 });
  }
}
