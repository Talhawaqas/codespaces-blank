// app/api/orgs/sign/requests/[requestId]/route.js
//
// GET /api/orgs/sign/requests/:requestId?orgId=

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getSigningRequest } from "../../../../../../lib/signing-workflow.js";

export async function GET(req, { params }) {
  try {
    const { requestId } = params;
    const orgId = req.nextUrl.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const r = await getSigningRequest({ orgId, requestId });
    if (!r) return NextResponse.json({ error: "Signing request not found." }, { status: 404 });

    return NextResponse.json({
      id: r._id.toString(), documentId: r.documentId.toString(), documentVersion: r.documentVersion,
      documentHash: r.documentHash, status: r.status,
      signers: r.signers.map((s) => ({ email: s.email, wallet: s.wallet, role: s.role, order: s.order, status: s.status, signedAt: s.signedAt, method: s.method })),
      deadline: r.deadline, message: r.message, createdByEmail: r.createdByEmail, createdAt: r.createdAt,
      completedAt: r.completedAt, anchorTxHash: r.anchorTxHash || null,
    });
  } catch (err) {
    console.error("orgs/sign/requests/[requestId] GET failed:", err);
    return NextResponse.json({ error: "Could not load the signing request." }, { status: 500 });
  }
}
