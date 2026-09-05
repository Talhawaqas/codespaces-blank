// app/api/orgs/health/patients/[patientId]/route.js
//
// GET /api/orgs/health/patients/:patientId?orgId=...
//   -> Patient 360: the patient record plus encounters, clinical record
//      metadata, upcoming appointments, and active consents -- everything
//      SOW section 10.3 lists, aggregated via Promise.all the same way
//      OsHomeView.js's own aggregate fetch already works. Visibility is
//      enforced by requiring the patient to appear in the caller's own
//      getAccessibleScope() result first -- a patientId the caller isn't
//      assigned to returns 404, identical to how a cross-org id lookup
//      behaves elsewhere in this codebase, not a 403 that would confirm
//      the record exists at all.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../../lib/document-permissions.js";
import { listClinicalRecordsForPatient } from "../../../../../../lib/health-clinical-workflow.js";
import { listAppointmentsForPatient } from "../../../../../../lib/health-scheduling.js";
import { listConsentsForPatient } from "../../../../../../lib/health-consent-workflow.js";
import { listPatientAccessEvents, logPatientAccess } from "../../../../../../lib/health-audit.js";

export async function GET(req, { params }) {
  try {
    const { patientId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const patient = scope.visiblePatients.find((p) => p._id.toString() === patientId);
    if (!patient) return NextResponse.json({ error: "Patient not found." }, { status: 404 });

    // SOW section 10.21 -- patient record VIEWS must be audited, not just
    // creates/changes. Awaited (not fire-and-forget) for the same reason
    // document-workflow.js's own notification calls are awaited: a
    // serverless function can freeze right after its response is sent.
    await logPatientAccess({ orgId, patientId, actorEmail: auth.session.email, action: "VIEWED", metadata: {} });

    const encounters = scope.visibleEncounters.filter((e) => e.patientId.toString() === patientId);
    const [clinicalRecords, appointments, consents, accessEvents] = await Promise.all([
      listClinicalRecordsForPatient(orgId, patientId),
      listAppointmentsForPatient(orgId, patientId),
      listConsentsForPatient(orgId, patientId),
      listPatientAccessEvents(orgId, patientId),
    ]);

    return NextResponse.json({
      patient: {
        id: patient._id.toString(), legalName: patient.legalName, preferredName: patient.preferredName,
        dateOfBirth: patient.dateOfBirth, status: patient.status, consentStatus: patient.consentStatus,
        facility: patient.facility, contacts: patient.contacts, emergencyContact: patient.emergencyContact,
      },
      encounters: encounters.map((e) => ({ id: e._id.toString(), reason: e.reason, date: e.date })),
      clinicalRecords: clinicalRecords.map((r) => ({ id: r._id.toString(), template: r.recordTemplate, status: r.status, createdAt: r.createdAt })),
      appointments: appointments.slice(0, 10).map((a) => ({ id: a._id.toString(), type: a.type, startAt: a.startAt, status: a.status })),
      consents: consents.map((c) => ({ id: c._id.toString(), type: c.type, purpose: c.purpose, status: c.status })),
      recentAccess: accessEvents.slice(0, 10).map((e) => ({ actorEmail: e.actorEmail, action: e.action, timestamp: e.timestamp })),
    });
  } catch (err) {
    console.error("orgs/health/patients/[patientId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch patient details." }, { status: 500 });
  }
}
