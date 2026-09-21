// app/api/orgs/storage/snapshots/route.js
// GET ?orgId=&resourceId= -> list; POST { orgId, resourceId } -> create a real snapshot

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createSnapshot, listSnapshots } from "../../../../../lib/storageSnapshots.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listSnapshots({ orgId, resourceId: searchParams.get("resourceId") || undefined, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/snapshots GET failed:", err);
    return NextResponse.json({ error: "Could not list snapshots." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, resourceId } = body;
    if (!orgId || !resourceId) return NextResponse.json({ error: "orgId and resourceId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createSnapshot({ orgId, resourceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ snapshot: { ...result.snapshot, _id: result.snapshot._id.toString() } });
  } catch (err) {
    console.error("orgs/storage/snapshots POST failed:", err);
    return NextResponse.json({ error: "Could not create snapshot." }, { status: 500 });
  }
}
