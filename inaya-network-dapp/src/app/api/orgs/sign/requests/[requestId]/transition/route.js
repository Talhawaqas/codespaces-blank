// app/api/orgs/sign/requests/[requestId]/transition/route.js
//
// POST /api/orgs/sign/requests/:requestId/transition
// Body: { orgId, action: "send"|"reject"|"revoke", signerIdentity?, reason? }
// "send" and "revoke" act as the request's creator/an org manager; "reject"
// acts as one of the invited signers (signerIdentity required).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { sendSigningRequest, rejectSigningRequest, revokeSigningRequest } from "../../../../../../../lib/signing-workflow.js";

export async function POST(req, { params }) {
  try {
    const { requestId } = params;
    const { orgId, action, signerIdentity, reason } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let result;
    if (action === "send") {
      result = await sendSigningRequest({ orgId, requestId, actorEmail: auth.session.email });
    } else if (action === "reject") {
      if (!signerIdentity) return NextResponse.json({ error: "signerIdentity is required to reject." }, { status: 400 });
      result = await rejectSigningRequest({ orgId, requestId, signerIdentity, reason, actorEmail: auth.session.email });
    } else if (action === "revoke") {
      result = await revokeSigningRequest({ orgId, requestId, membership: auth.membership, actorEmail: auth.session.email });
    } else {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }

    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ status: result.request.status });
  } catch (err) {
    console.error("orgs/sign/requests/[requestId]/transition POST failed:", err);
    return NextResponse.json({ error: "Could not update the signing request." }, { status: 500 });
  }
}
