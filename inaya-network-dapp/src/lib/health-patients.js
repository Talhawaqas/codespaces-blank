// src/lib/health-patients.js
//
// Healthcare & Legal Expansion SOW, Phase 2 (§10.2) — patient registry.
// Visibility itself lives in document-permissions.js's getAccessibleScope()
// (assignment-based via health_care_team_assignments); this module owns
// creation, care-team assignment, and duplicate detection only.
//
// Duplicate detection is a simple, honest heuristic (matching legal/
// preferred name + date of birth) that surfaces CANDIDATES for a human to
// review — it never auto-merges. Merging two patient records is a
// human-reviewed action per SOW §10.2, not something this function does
// on its own.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { canAccessHealthRecords } from "./orgGates.js";
import { logPatientAccess } from "./health-audit.js";

export async function findDuplicatePatientCandidates({ orgId, legalName, dateOfBirth }) {
  const { healthPatients } = await getOrgCollections();
  if (!legalName || !dateOfBirth) return [];
  return healthPatients
    .find({ orgId: toObjectId(orgId), deletedAt: null, legalName: { $regex: `^${legalName.trim()}$`, $options: "i" }, dateOfBirth })
    .toArray();
}

export async function createPatient({ orgId, legalName, preferredName, dateOfBirth, contacts, emergencyContact, demographics, insuranceReferences, primaryProviderId, facility, classification, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to register a patient.", status: 403 };
  const { healthPatients } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), legalName, preferredName: preferredName || null, dateOfBirth,
    contacts: contacts || [], emergencyContact: emergencyContact || null, demographics: demographics || {},
    insuranceReferences: insuranceReferences || [], primaryProviderId: primaryProviderId ? toObjectId(primaryProviderId) : null,
    careTeamIds: [], facility: facility || null, status: "active", consentStatus: "unknown",
    classification: classification || "PATIENT_SENSITIVE",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await healthPatients.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logPatientAccess({ orgId, patientId: inserted._id, actorEmail, action: "CREATED", metadata: {} });
  return { patient: inserted };
}

/** Assigns a member to a patient's care team — the write side of the
 *  health_care_team_assignments join table getAccessibleScope() reads.
 *  Only a health manager (or org owner/admin) may assign; being assigned
 *  is what grants an ordinary staff member visibility into that specific
 *  patient, not the other way around. */
export async function assignCareTeamMember({ orgId, patientId, memberEmail, role, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to manage this patient's care team.", status: 403 };
  const { healthCareTeamAssignments, healthPatients } = await getOrgCollections();
  const patient = await healthPatients.findOne({ _id: toObjectId(patientId), orgId: toObjectId(orgId), deletedAt: null });
  if (!patient) return { error: "Patient not found.", status: 404 };

  const now = new Date().toISOString();
  await healthCareTeamAssignments.findOneAndUpdate(
    { orgId: toObjectId(orgId), patientId: toObjectId(patientId), email: memberEmail },
    { $set: { role: role || "member", updatedAt: now }, $setOnInsert: { createdAt: now, assignedByEmail: actorEmail } },
    { upsert: true }
  );
  await logPatientAccess({ orgId, patientId: patient._id, actorEmail, action: "CARE_TEAM_ASSIGNED", metadata: { memberEmail, role } });
  return { assigned: true };
}

/** Human-reviewed merge — the caller has already reviewed the duplicate
 *  candidates and confirmed these two records are the same person. Marks
 *  the duplicate as merged (never hard-deletes it — same "never silently
 *  destroy data" discipline as every workflow in this codebase) and
 *  records the merge decision on the surviving record. */
export async function mergePatients({ orgId, survivingPatientId, duplicatePatientId, actorEmail, membership }) {
  if (!canManageOrg(membership) && !canAccessHealthRecords(membership)) return { error: "You don't have permission to merge patient records.", status: 403 };
  const { healthPatients } = await getOrgCollections();
  const now = new Date().toISOString();

  const duplicate = await healthPatients.findOneAndUpdate(
    { _id: toObjectId(duplicatePatientId), orgId: toObjectId(orgId), deletedAt: null },
    { $set: { deletedAt: now, mergedInto: toObjectId(survivingPatientId), mergedByEmail: actorEmail, mergedAt: now } },
    { returnDocument: "after" }
  );
  if (!duplicate) return { error: "Duplicate patient record not found (or already merged).", status: 404 };

  await logPatientAccess({ orgId, patientId: duplicate._id, actorEmail, action: "MERGED", metadata: { survivingPatientId } });
  return { merged: duplicate };
}
