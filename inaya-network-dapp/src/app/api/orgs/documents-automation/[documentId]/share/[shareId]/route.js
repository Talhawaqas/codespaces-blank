// app/api/orgs/documents-automation/[documentId]/share/[shareId]/route.js
// DELETE ?orgId= -> revokes a secure delivery link for real (the token stops working immediately)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageFinance } from "../../../../../../../lib/orgs.js";
import { revokeDocumentDeliveryLink } from "../../../../../../../lib/documentAutomation/delivery.js";

export async function DELETE(req, { params }) {
  try {
    const { documentId, shareId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageFinance(auth.membership)) return NextResponse.json({ error: "Only finance can revoke this link." }, { status: 403 });

    const result = await revokeDocumentDeliveryLink({ orgId, documentId, shareId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/documents-automation/[documentId]/share/[shareId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke the link." }, { status: 500 });
  }
}
