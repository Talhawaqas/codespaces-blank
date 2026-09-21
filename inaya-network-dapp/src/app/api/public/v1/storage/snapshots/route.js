// app/api/public/v1/storage/snapshots/route.js
//
// Authorization: Bearer <apiKey>. GET ?resourceId= -> list; POST
// { resourceId } -> create (a real copy-forward-restorable snapshot --
// see storageSnapshots.js's module header for how it actually works).

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../lib/api-keys.js";
import { createSnapshot, listSnapshots } from "../../../../../../lib/storageSnapshots.js";

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { searchParams } = new URL(req.url);
    const resourceId = searchParams.get("resourceId") || undefined;
    const result = await listSnapshots({ orgId: auth.orgId, resourceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/snapshots GET failed:", err);
    return NextResponse.json({ error: "Could not list snapshots." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));
    const { resourceId } = body;
    const result = await createSnapshot({ orgId: auth.orgId, resourceId, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ snapshot: { ...result.snapshot, _id: result.snapshot._id.toString(), sourceResourceId: result.snapshot.sourceResourceId.toString() } });
  } catch (err) {
    console.error("public/v1/storage/snapshots POST failed:", err);
    return NextResponse.json({ error: "Could not create snapshot." }, { status: 500 });
  }
}
