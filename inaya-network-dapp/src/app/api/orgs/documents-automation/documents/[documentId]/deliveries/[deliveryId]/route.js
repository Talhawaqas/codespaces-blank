// DELETE /api/orgs/documents-automation/documents/[documentId]/deliveries/[deliveryId]?orgId=&reason=
//   -> revokes a secure link / Data Room delivery immediately.
import { NextResponse } from "next/server";
import { authed, fail, respond, limited } from "../../../../_lib.js";
import { revokeDelivery } from "../../../../../../../../lib/documentAutomation/delivery.js";

export const dynamic = "force-dynamic";

export async function DELETE(req, { params }) {
  try {
    const { documentId, deliveryId } = await params;
    const sp = new URL(req.url).searchParams;
    const a = await authed(req, sp.get("orgId"));
    if (a.response) return a.response;
    const rl = await limited(req, { action: "revoke", max: 60, key: a.email });
    if (rl) return rl;
    const result = await revokeDelivery({ orgId: sp.get("orgId"), documentId, deliveryId, membership: a.membership, email: a.email, reason: (sp.get("reason") || "revoked by sender").slice(0, 200) });
    if (result.error) return respond(result);
    return NextResponse.json({ revoked: true });
  } catch (err) { return fail(err, "delivery DELETE"); }
}
