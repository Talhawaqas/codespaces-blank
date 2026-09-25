// app/api/orgs/documents-automation/[documentId]/share/route.js
// POST { orgId, expiresPreset?, recipientEmail? } -> creates a real, time-limited, revocable secure delivery link

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageFinance } from "../../../../../../lib/orgs.js";
import { createDocumentDeliveryLink } from "../../../../../../lib/documentAutomation/delivery.js";

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, expiresPreset, recipientEmail } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageFinance(auth.membership)) return NextResponse.json({ error: "Only finance can share this document." }, { status: 403 });

    const result = await createDocumentDeliveryLink({ orgId, documentId, membership: auth.membership, actorEmail: auth.session.email, expiresPreset: expiresPreset || "7d", recipientEmail });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("orgs/documents-automation/[documentId]/share POST failed:", err);
    return NextResponse.json({ error: "Could not create a delivery link." }, { status: 500 });
  }
}
