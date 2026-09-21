// app/api/orgs/storage/snapshots/[snapshotId]/route.js
// GET ?orgId= -> detail; DELETE { orgId } -> delete

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getSnapshot, deleteSnapshot } from "../../../../../../lib/storageSnapshots.js";

export async function GET(req, { params }) {
  try {
    const { snapshotId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getSnapshot({ orgId, snapshotId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/snapshots/[snapshotId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch snapshot." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { snapshotId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteSnapshot({ orgId, snapshotId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/snapshots/[snapshotId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete snapshot." }, { status: 500 });
  }
}
