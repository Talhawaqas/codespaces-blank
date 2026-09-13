// app/api/orgs/attestations/[attestationId]/verify/route.js
//
// GET /api/orgs/attestations/:attestationId/verify?orgId=
// Independent verification -- recomputes the dataset commitment fresh from
// the same real records, every call. Returns exactly VALID | INVALID |
// UNSUPPORTED_VERSION | EXPIRED_SUPERSEDED, per the SOW's own required
// verifier contract. Never returns underlying invoice/expense records.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAttestations } from "../../../../../../lib/orgs.js";
import { verifyAttestation } from "../../../../../../lib/financial-attestation.js";

export async function GET(req, { params }) {
  try {
    const { attestationId } = params;
    const orgId = req.nextUrl.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessAttestations(auth.membership)) return NextResponse.json({ error: "You don't have attestation access." }, { status: 403 });

    const result = await verifyAttestation({ orgId, attestationId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/attestations/[attestationId]/verify GET failed:", err);
    return NextResponse.json({ error: "Could not verify the attestation." }, { status: 500 });
  }
}
