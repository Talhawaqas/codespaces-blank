// app/api/orgs/sign/requests/[requestId]/verify/route.js
//
// GET /api/orgs/sign/requests/:requestId/verify?orgId=
// Independent verification — recomputes the document hash comparison and
// the audit-chain check fresh on every call, never trusts a stored flag.
// See signing-workflow.js's verifySigningRequest() for the full logic.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { verifySigningRequest } from "../../../../../../../lib/signing-workflow.js";

export async function GET(req, { params }) {
  try {
    const { requestId } = params;
    const orgId = req.nextUrl.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await verifySigningRequest({ orgId, requestId });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/sign/requests/[requestId]/verify GET failed:", err);
    return NextResponse.json({ error: "Could not verify the signing request." }, { status: 500 });
  }
}
