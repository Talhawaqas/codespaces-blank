// app/api/orgs/nas/users/[nasUserId]/route.js
// DELETE ?orgId= -> real appliance-side revocation (smbpasswd -d) + record revoked

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { revokeNasUser } from "../../../../../../lib/nas/users.js";

export async function DELETE(req, { params }) {
  try {
    const { nasUserId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await revokeNasUser({ orgId, nasUserId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/users/[nasUserId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke NAS user." }, { status: 500 });
  }
}
