// app/api/orgs/documents/[documentId]/shares/[shareId]/revoke/route.js
//
// POST /api/orgs/documents/:documentId/shares/:shareId/revoke  { orgId }
//
// Immediate, server-side revocation — MANAGE required. Atomic conditional
// update (revokedAt: null in the filter) means calling this twice is safe:
// the second call just finds nothing left to revoke rather than double-
// logging. Once revoked, consumeDocumentShare() (document-permissions.js)
// rejects the token on its very next use — no caching/propagation delay,
// since every access re-reads the share document.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../../lib/orgs.js";
import { requireDocumentAccess, revokeDocumentShare } from "../../../../../../../../lib/document-permissions.js";
import { logDocumentActivity } from "../../../../../../../../lib/document-workflow.js";

export async function POST(req, { params }) {
  try {
    const { documentId, shareId } = params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const access = await requireDocumentAccess({ orgId, documentId, membership: auth.membership, email: auth.session.email, minLevel: "MANAGE" });
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

    const revoked = await revokeDocumentShare({ orgId, documentId, shareId });
    if (!revoked) {
      return NextResponse.json({ error: "That share doesn't exist or was already revoked." }, { status: 404 });
    }

    await logDocumentActivity({
      organizationId: orgId,
      documentId,
      actorId: auth.session.email,
      action: "DOCUMENT_SHARE_REVOKED",
      previousState: null,
      newState: null,
      metadata: { shareId },
    });

    return NextResponse.json({ revoked: true });
  } catch (err) {
    console.error("orgs/documents/[documentId]/shares/[shareId]/revoke failed:", err);
    return NextResponse.json({ error: "Could not revoke the share." }, { status: 500 });
  }
}
