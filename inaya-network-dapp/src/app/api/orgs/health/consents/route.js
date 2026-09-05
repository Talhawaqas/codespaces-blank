// app/api/orgs/health/consents/route.js
// GET  ?orgId=&patientId= -> list consents for a patient (must be in caller's visible scope)
// POST { orgId, patientId, type, purpose, ... } -> record consent
// PATCH { orgId, consentId, action:"withdraw" } -> withdraw

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { recordConsent, withdrawConsent, listConsentsForPatient } from "../../../../../lib/health-consent-workflow.js";

function serialize(c) {
  return { id: c._id.toString(), type: c.type, purpose: c.purpose, status: c.status, effectiveDate: c.effectiveDate, expiryDate: c.expiryDate };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const patientId = searchParams.get("patientId");
    if (!orgId || !patientId) return NextResponse.json({ error: "orgId and patientId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    if (!scope.visiblePatients.some((p) => p._id.toString() === patientId)) {
      return NextResponse.json({ error: "Patient not found." }, { status: 404 });
    }

    const consents = await listConsentsForPatient(orgId, patientId);
    return NextResponse.json({ consents: consents.map(serialize) });
  } catch (err) {
    console.error("orgs/health/consents GET failed:", err);
    return NextResponse.json({ error: "Could not fetch consents." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, patientId, type, purpose } = body;
    if (!orgId || !patientId || !type || !purpose) return NextResponse.json({ error: "orgId, patientId, type, and purpose are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await recordConsent({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ consent: serialize(result.consent) });
  } catch (err) {
    console.error("orgs/health/consents POST failed:", err);
    return NextResponse.json({ error: "Could not record consent." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, consentId } = await req.json();
    if (!orgId || !consentId) return NextResponse.json({ error: "orgId and consentId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await withdrawConsent({ orgId, consentId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ consent: serialize(result.consent) });
  } catch (err) {
    console.error("orgs/health/consents PATCH failed:", err);
    return NextResponse.json({ error: "Could not withdraw consent." }, { status: 500 });
  }
}
