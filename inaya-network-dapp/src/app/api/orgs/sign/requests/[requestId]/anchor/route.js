// app/api/orgs/sign/requests/[requestId]/anchor/route.js
//
// POST /api/orgs/sign/requests/:requestId/anchor
// Optional, real on-chain anchor for a FULLY_SIGNED request. See
// signing-workflow.js's anchorSigningRequestOnChain() header comment.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessSigning } from "../../../../../../../lib/orgs.js";
import { anchorSigningRequestOnChain } from "../../../../../../../lib/signing-workflow.js";

export async function POST(req, { params }) {
  try {
    const { requestId } = params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessSigning(auth.membership)) return NextResponse.json({ error: "You don't have signing access." }, { status: 403 });

    const result = await anchorSigningRequestOnChain({ orgId, requestId, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/sign/requests/[requestId]/anchor POST failed:", err);
    return NextResponse.json({ error: "Could not anchor the signing request on-chain." }, { status: 500 });
  }
}
