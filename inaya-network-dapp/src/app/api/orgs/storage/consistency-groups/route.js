// app/api/orgs/storage/consistency-groups/route.js
// GET ?orgId= -> list; POST { orgId, resourceIds } -> create (sequential
// capture, honest SEQUENTIAL_NOT_ATOMIC consistency boundary -- see
// storageSnapshots.js's own module header)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createConsistencyGroup, listConsistencyGroups } from "../../../../../lib/storageSnapshots.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listConsistencyGroups({ orgId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/consistency-groups GET failed:", err);
    return NextResponse.json({ error: "Could not list consistency groups." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, resourceIds } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createConsistencyGroup({ orgId, resourceIds, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/consistency-groups POST failed:", err);
    return NextResponse.json({ error: "Could not create consistency group." }, { status: 500 });
  }
}
