// GET  /api/orgs/documents-automation/documents/[documentId]/deliveries?orgId=
//        -> deliveries (links / Data Room) and recipient access history.
// POST /api/orgs/documents-automation/documents/[documentId]/deliveries
//        { orgId, mode: "link" | "data_room", recipientEmail?, expiresPreset?, customExpiresAt?, maxUses?, notify?, ndaRequired?, ndaText? }
//        -> creates a secure delivery bound to this exact version. The raw
//           link/token is returned ONCE; only its hash is stored.
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { createDelivery, listDeliveries } from "../../../../../../../lib/documentAutomation/delivery.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    return respond(await listDeliveries({ orgId, documentId, membership: a.membership, email: a.email }));
  } catch (err) { return fail(err, "deliveries GET"); }
}

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const j = await readJson(req);
    if (j.error) return respond(j);
    const { orgId, mode, recipientEmail, expiresPreset, customExpiresAt, maxUses, notify, ndaRequired, ndaText } = j.body;
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "delivery", max: 30, key: a.email });
    if (rl) return rl;
    const result = await createDelivery({ orgId, documentId, mode, recipientEmail, expiresPreset: expiresPreset || "7d", customExpiresAt, maxUses: maxUses ?? null, notify: notify !== false, ndaRequired: ndaRequired === true, ndaText, membership: a.membership, email: a.email });
    if (result.error) return respond(result);
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) { return fail(err, "deliveries POST"); }
}
