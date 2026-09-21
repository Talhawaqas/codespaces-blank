// app/api/orgs/storage/snapshots/[snapshotId]/restore/route.js
// POST { orgId } -> a real, normal copy-forward restore (never "fast restore" -- see storageSnapshots.js's own module header)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { restoreSnapshot } from "../../../../../../../lib/storageSnapshots.js";

export async function POST(req, { params }) {
  try {
    const { snapshotId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await restoreSnapshot({ orgId, snapshotId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/snapshots/[snapshotId]/restore POST failed:", err);
    return NextResponse.json({ error: "Could not restore snapshot." }, { status: 500 });
  }
}
