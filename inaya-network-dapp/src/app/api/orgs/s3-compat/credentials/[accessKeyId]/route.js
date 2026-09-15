// DELETE /api/orgs/s3-compat/credentials/:accessKeyId — body: { orgId }. Owner/admin only.
import { NextResponse } from "next/server";
import { requireMembership, canManageOrg } from "../../../../../../lib/orgs.js";
import { revokeS3Credential } from "../../../../../../lib/s3-compat/credentials.js";

export async function DELETE(req, { params }) {
  try {
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can revoke an S3-compatible credential." }, { status: 403 });

    const revoked = await revokeS3Credential({ owner: { type: "org", orgId }, accessKeyId: params.accessKeyId });
    if (!revoked) return NextResponse.json({ error: "Credential not found or already revoked." }, { status: 404 });
    return NextResponse.json({ revoked: true });
  } catch (err) {
    console.error("orgs/s3-compat/credentials/[accessKeyId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke the credential." }, { status: 500 });
  }
}
