// app/api/orgs/health/patients/route.js
//
// GET  /api/orgs/health/patients?orgId=...&search=...
//   -> the caller's assignment-scoped visible patients (getAccessibleScope,
//      NOT department-filtered -- patient visibility is care-team
//      assignment based, see document-permissions.js's Phase 2/6 block).
// POST /api/orgs/health/patients  { orgId, legalName, dateOfBirth, ... }
//   -> create (canAccessHealthRecords-gated, enforced inside createPatient()).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { createPatient } from "../../../../../lib/health-patients.js";

function serializePatient(p) {
  return {
    id: p._id.toString(), legalName: p.legalName, preferredName: p.preferredName,
    dateOfBirth: p.dateOfBirth, status: p.status, consentStatus: p.consentStatus,
    facility: p.facility, classification: p.classification, createdAt: p.createdAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const search = searchParams.get("search");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    let list = scope.visiblePatients;
    if (search) {
      const needle = search.toLowerCase();
      list = list.filter((p) => (p.legalName || "").toLowerCase().includes(needle) || (p.preferredName || "").toLowerCase().includes(needle));
    }

    return NextResponse.json({ patients: list.map(serializePatient) });
  } catch (err) {
    console.error("orgs/health/patients GET failed:", err);
    return NextResponse.json({ error: "Could not fetch patients." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, legalName, dateOfBirth } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!legalName || !dateOfBirth) return NextResponse.json({ error: "legalName and dateOfBirth are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createPatient({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ patient: serializePatient(result.patient) });
  } catch (err) {
    console.error("orgs/health/patients POST failed:", err);
    return NextResponse.json({ error: "Could not create the patient record." }, { status: 500 });
  }
}
