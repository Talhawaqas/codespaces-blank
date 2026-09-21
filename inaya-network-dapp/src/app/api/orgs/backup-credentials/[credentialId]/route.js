// app/api/orgs/backup-credentials/[credentialId]/route.js
// DELETE { orgId } -> revoke this credential (any schedule using it will fail its next run with a clear "revoked" reason)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { revokeBackupCredential } from "../../../../../lib/backupCryptoAndCredentials.js";

export async function DELETE(req, { params }) {
  try {
    const { credentialId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await revokeBackupCredential({ orgId, credentialId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/backup-credentials/[credentialId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke this credential." }, { status: 500 });
  }
}
