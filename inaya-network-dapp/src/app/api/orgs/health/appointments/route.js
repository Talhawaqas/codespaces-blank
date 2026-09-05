// app/api/orgs/health/appointments/route.js
// GET   ?orgId=&patientId= -> list appointments for a patient
// POST  { orgId, patientId, type, startAt, ... } -> schedule
// PATCH { orgId, appointmentId, status } -> update status

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { scheduleAppointment, updateAppointmentStatus, listAppointmentsForPatient } from "../../../../../lib/health-scheduling.js";

function serialize(a) {
  return { id: a._id.toString(), type: a.type, startAt: a.startAt, endAt: a.endAt, status: a.status, location: a.location };
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
    const appointments = await listAppointmentsForPatient(orgId, patientId);
    return NextResponse.json({ appointments: appointments.map(serialize) });
  } catch (err) {
    console.error("orgs/health/appointments GET failed:", err);
    return NextResponse.json({ error: "Could not fetch appointments." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.patientId || !body.type || !body.startAt) return NextResponse.json({ error: "orgId, patientId, type, and startAt are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await scheduleAppointment({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ appointment: serialize(result.appointment) });
  } catch (err) {
    console.error("orgs/health/appointments POST failed:", err);
    return NextResponse.json({ error: "Could not schedule appointment." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, appointmentId, status } = await req.json();
    if (!orgId || !appointmentId || !status) return NextResponse.json({ error: "orgId, appointmentId, and status are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateAppointmentStatus({ orgId, appointmentId, status, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ appointment: serialize(result.appointment) });
  } catch (err) {
    console.error("orgs/health/appointments PATCH failed:", err);
    return NextResponse.json({ error: "Could not update appointment." }, { status: 500 });
  }
}
