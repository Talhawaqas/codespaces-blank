// app/api/orgs/storage/snapshots/[snapshotId]/share/route.js
// POST { orgId, recipientOrgId, operationScope, expiresAt } -> grant a cross-org
// snapshot share. DELETE { orgId, grantId } -> revoke one.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { shareSnapshot, revokeSnapshotGrant } from "../../../../../../../lib/storageSnapshots.js";

export async function POST(req, { params }) {
  try {
    const { snapshotId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, recipientOrgId, operationScope, expiresAt } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await shareSnapshot({ orgId, snapshotId, recipientOrgId, operationScope, expiresAt, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ grantId: result.grantId.toString() });
  } catch (err) {
    console.error("orgs/storage/snapshots/[snapshotId]/share POST failed:", err);
    return NextResponse.json({ error: "Could not share snapshot." }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, grantId } = body;
    if (!orgId || !grantId) return NextResponse.json({ error: "orgId and grantId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await revokeSnapshotGrant({ orgId, grantId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/snapshots/[snapshotId]/share DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke snapshot share." }, { status: 500 });
  }
}
