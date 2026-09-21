// app/api/public/v1/storage/resources/[resourceId]/route.js
//
// Authorization: Bearer <apiKey>. GET -> detail; PATCH { action: "expand",
// newCapacityGB } -> capacity expand (increase-only, per
// storageResources.js's own rule); DELETE -> delete.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { getStorageResource, expandStorageResourceCapacity, deleteStorageResource } from "../../../../../../../lib/storageResources.js";

export async function GET(req, { params }) {
  try {
    const { resourceId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getStorageResource({ orgId: auth.orgId, resourceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/resources/[resourceId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch storage resource." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { resourceId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));
    const { action, newCapacityGB } = body;
    if (action !== "expand") return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    const result = await expandStorageResourceCapacity({ orgId: auth.orgId, resourceId, newCapacityGB, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/resources/[resourceId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update storage resource." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { resourceId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteStorageResource({ orgId: auth.orgId, resourceId, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/resources/[resourceId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete storage resource." }, { status: 500 });
  }
}
