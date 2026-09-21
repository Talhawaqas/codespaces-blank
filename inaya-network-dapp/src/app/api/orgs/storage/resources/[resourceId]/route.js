// app/api/orgs/storage/resources/[resourceId]/route.js
// GET ?orgId= -> detail; PATCH { orgId, action: "expand", newCapacityGB } -> capacity expand; DELETE { orgId } -> delete

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getStorageResource, expandStorageResourceCapacity, deleteStorageResource } from "../../../../../../lib/storageResources.js";

export async function GET(req, { params }) {
  try {
    const { resourceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getStorageResource({ orgId, resourceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/resources/[resourceId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch storage resource." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { resourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, action, newCapacityGB } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    if (action !== "expand") return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    const result = await expandStorageResourceCapacity({ orgId, resourceId, newCapacityGB, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/resources/[resourceId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update storage resource." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { resourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteStorageResource({ orgId, resourceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/resources/[resourceId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete storage resource." }, { status: 500 });
  }
}
