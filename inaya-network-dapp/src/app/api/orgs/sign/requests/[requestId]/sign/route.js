// app/api/orgs/sign/requests/[requestId]/sign/route.js
//
// POST /api/orgs/sign/requests/:requestId/sign
// Body: { orgId, signerIdentity: {email?, wallet?}, method: "wallet"|"session_consent", proof }
//   method "wallet": proof = { walletAddress, message, signature, timestamp } —
//     a fresh ethers signature over buildInayaSignMessage(), verified server-side.
//   method "session_consent": proof = { typedName, consent:true } — the signer
//     must be signed in as the invited email; recorded as consent, never as
//     a cryptographic signature.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { recordSignature } from "../../../../../../../lib/signing-workflow.js";

export async function POST(req, { params }) {
  try {
    const { requestId } = params;
    const { orgId, signerIdentity, method, proof } = await req.json();
    if (!orgId || !signerIdentity || !method) {
      return NextResponse.json({ error: "orgId, signerIdentity, and method are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await recordSignature({ orgId, requestId, signerIdentity, method, proof, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.request.status, completed: result.completed });
  } catch (err) {
    console.error("orgs/sign/requests/[requestId]/sign POST failed:", err);
    return NextResponse.json({ error: "Could not record the signature." }, { status: 500 });
  }
}
