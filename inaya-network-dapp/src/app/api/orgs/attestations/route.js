// app/api/orgs/attestations/route.js
//
// POST /api/orgs/attestations  { orgId, statementType, startDate, endDate, threshold, displayCurrency? }
// GET  /api/orgs/attestations?orgId=
//
// "Cryptographic Financial Attestation" -- NOT a zero-knowledge proof, see
// financial-attestation.js's header comment for exactly what this is and
// why. Never returns underlying invoice/expense records to the client —
// only the commitment, the statement, and the result.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAttestations } from "../../../../lib/orgs.js";
import { generateAttestation, listAttestations } from "../../../../lib/financial-attestation.js";

function serialize(a) {
  return {
    id: a._id.toString(), statementType: a.statementType, period: a.period, statementParams: a.statementParams,
    datasetCommitment: a.datasetCommitment, recordCount: a.recordCount, result: a.result, status: a.status,
    generatedByEmail: a.generatedByEmail, generatedAt: a.generatedAt, verifiedAt: a.verifiedAt,
    // computedTotal is deliberately NOT serialized -- the underlying
    // aggregate is retained server-side for re-verification only.
  };
}

export async function POST(req) {
  try {
    const { orgId, statementType, startDate, endDate, threshold, displayCurrency } = await req.json();
    if (!orgId || !statementType || !startDate || !endDate) {
      return NextResponse.json({ error: "orgId, statementType, startDate, and endDate are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await generateAttestation({ orgId, statementType, startDate, endDate, threshold, displayCurrency, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({
      attestationId: result.attestationId.toString(), datasetCommitment: result.datasetCommitment, result: result.result,
      disclaimer: "This is a cryptographic hash-commitment and server-attested computation over real financial data — not a zero-knowledge proof, and not a government/tax/regulatory certification of any kind.",
    });
  } catch (err) {
    console.error("orgs/attestations POST failed:", err);
    return NextResponse.json({ error: "Could not generate the attestation." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessAttestations(auth.membership)) return NextResponse.json({ error: "You don't have attestation access." }, { status: 403 });

    const list = await listAttestations(orgId);
    return NextResponse.json({ attestations: list.map(serialize) });
  } catch (err) {
    console.error("orgs/attestations GET failed:", err);
    return NextResponse.json({ error: "Could not fetch attestations." }, { status: 500 });
  }
}
