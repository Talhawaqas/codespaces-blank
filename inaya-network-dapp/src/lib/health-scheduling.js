// src/lib/health-scheduling.js
//
// Healthcare & Legal Expansion SOW, Phase 4 (§10.9) — appointment
// scheduling. A simple CRUD + status lifecycle (not a full transitions
// table — the SOW doesn't define strict from/to rules for scheduling the
// way it does for clinical documentation or matters) plus a reminder
// notification hook reusing notifications.js directly.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessHealthRecords } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const APPOINTMENT_STATUSES = ["SCHEDULED", "CONFIRMED", "CANCELLED", "COMPLETED", "NO_SHOW"];

export async function scheduleAppointment({ orgId, patientId, providerId, departmentId, type, startAt, endAt, location, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to schedule an appointment.", status: 403 };
  const { healthAppointments } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), patientId: toObjectId(patientId), providerId: providerId ? toObjectId(providerId) : null,
    departmentId: departmentId ? toObjectId(departmentId) : null, type, startAt, endAt: endAt || null, location: location || null,
    status: "SCHEDULED", reminderSentAt: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await healthAppointments.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "APPOINTMENT", recordId: inserted._id, actorEmail, action: "SCHEDULED", previousState: null, newState: "SCHEDULED", metadata: { patientId, startAt } });
  return { appointment: inserted };
}

export async function updateAppointmentStatus({ orgId, appointmentId, status, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to update this appointment.", status: 403 };
  if (!APPOINTMENT_STATUSES.includes(status)) return { error: `Unknown status "${status}".`, status: 400 };
  const { healthAppointments } = await getOrgCollections();
  const current = await healthAppointments.findOne({ _id: toObjectId(appointmentId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Appointment not found.", status: 404 };
  const updated = await healthAppointments.findOneAndUpdate(
    { _id: toObjectId(appointmentId), orgId: toObjectId(orgId) },
    { $set: { status, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "APPOINTMENT", recordId: updated._id, actorEmail, action: "STATUS_CHANGED", previousState: current.status, newState: status, metadata: {} });
  return { appointment: updated };
}

/** Sends a real reminder notification for appointments in the next
 *  window, marking reminderSentAt so it's never sent twice — same
 *  idempotency discipline as invoice-workflow.js's markOverdueInvoices,
 *  intended to be cron-driven the same way. */
export async function sendUpcomingAppointmentReminders(hoursAhead = 24) {
  const { healthAppointments } = await getOrgCollections();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000).toISOString();
  const due = await healthAppointments.find({ status: { $in: ["SCHEDULED", "CONFIRMED"] }, startAt: { $gte: now.toISOString(), $lte: windowEnd }, reminderSentAt: null }).toArray();

  let sent = 0;
  for (const appt of due) {
    const updated = await healthAppointments.findOneAndUpdate(
      { _id: appt._id, reminderSentAt: null },
      { $set: { reminderSentAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    if (!updated) continue; // already sent by a concurrent run
    await createNotification({
      scope: "org", orgId: appt.orgId, targetEmail: null, category: "business", severity: "info",
      type: "appointment_reminder", title: "Upcoming appointment", body: `Appointment scheduled at ${appt.startAt}`,
      sourceModule: "health-scheduling", sourceId: appt._id, actionUrl: "/business?view=health",
      dedupeKey: `${appt.orgId}:appointment_reminder:${appt._id}`,
    });
    sent += 1;
  }
  return { checked: due.length, sent };
}

export async function listAppointmentsForPatient(orgId, patientId) {
  const { healthAppointments } = await getOrgCollections();
  return healthAppointments.find({ orgId: toObjectId(orgId), patientId: toObjectId(patientId) }).sort({ startAt: -1 }).toArray();
}
