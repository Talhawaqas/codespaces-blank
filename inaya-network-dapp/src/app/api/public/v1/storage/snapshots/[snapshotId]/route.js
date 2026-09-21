// app/api/public/v1/storage/snapshots/[snapshotId]/route.js
//
// Authorization: Bearer <apiKey>. GET -> detail; DELETE -> delete.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { getSnapshot, deleteSnapshot } from "../../../../../../../lib/storageSnapshots.js";

export async function GET(req, { params }) {
  try {
    const { snapshotId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getSnapshot({ orgId: auth.orgId, snapshotId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/snapshots/[snapshotId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch snapshot." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { snapshotId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteSnapshot({ orgId: auth.orgId, snapshotId, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/snapshots/[snapshotId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete snapshot." }, { status: 500 });
  }
}
