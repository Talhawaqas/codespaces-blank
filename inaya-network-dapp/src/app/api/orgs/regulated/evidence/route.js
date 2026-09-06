// app/api/orgs/regulated/evidence/route.js
// GET  ?orgId=&controlId=&reviewStatus= -> list evidence
// POST { orgId, controlId, type, sourceRef, hash, validFrom, validUntil, classification } -> submit evidence

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { submitEvidence, listEvidence } from "../../../../../lib/compliance-evidence.js";

function serialize(e) {
  return {
    id: e._id.toString(), controlId: e.controlId?.toString() || null, type: e.type, sourceRef: e.sourceRef,
    classification: e.classification, version: e.version, reviewStatus: e.reviewStatus, reviewerEmail: e.reviewerEmail,
    reviewedAt: e.reviewedAt, validFrom: e.validFrom, validUntil: e.validUntil, submittedByEmail: e.submittedByEmail,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessCompliance(auth.membership)) return NextResponse.json({ error: "You don't have compliance access." }, { status: 403 });

    const evidence = await listEvidence(orgId, { controlId: searchParams.get("controlId") || undefined, reviewStatus: searchParams.get("reviewStatus") || undefined });
    return NextResponse.json({ evidence: evidence.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/evidence GET failed:", err);
    return NextResponse.json({ error: "Could not fetch evidence." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, type } = body;
    if (!orgId || !type) return NextResponse.json({ error: "orgId and type are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await submitEvidence({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ evidence: serialize(result.evidence) });
  } catch (err) {
    console.error("orgs/regulated/evidence POST failed:", err);
    return NextResponse.json({ error: "Could not submit evidence." }, { status: 500 });
  }
}
