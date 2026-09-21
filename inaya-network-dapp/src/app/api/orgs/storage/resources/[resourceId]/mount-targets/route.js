// app/api/orgs/storage/resources/[resourceId]/mount-targets/route.js
// POST { orgId, label, protocol, authorizedClients } -> add a DECLARED mount
// target (bookkeeping only -- see storageResources.js's own module header,
// nothing here is a real, connectable NFS endpoint).
// DELETE { orgId, mountTargetId } -> remove one.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { addMountTarget, removeMountTarget } from "../../../../../../../lib/storageResources.js";

export async function POST(req, { params }) {
  try {
    const { resourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, label, protocol, authorizedClients } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await addMountTarget({ orgId, resourceId, label, protocol, authorizedClients, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/resources/[resourceId]/mount-targets POST failed:", err);
    return NextResponse.json({ error: "Could not add mount target." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { resourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, mountTargetId } = body;
    if (!orgId || !mountTargetId) return NextResponse.json({ error: "orgId and mountTargetId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await removeMountTarget({ orgId, resourceId, mountTargetId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/resources/[resourceId]/mount-targets DELETE failed:", err);
    return NextResponse.json({ error: "Could not remove mount target." }, { status: 500 });
  }
}
