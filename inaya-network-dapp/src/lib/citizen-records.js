// src/lib/citizen-records.js
//
// Government & Public Sector Sovereign OS SOW, Phase 1 (§4 "Citizen
// Records", §C "need-to-know access", "assignment-based access to
// sensitive records"). Structurally closer to health-patients.js's
// Patient registry than to CRM's Contact/Deal — a record ABOUT a
// person, with need-to-know/assignment-based visibility, not a company's
// own customer/lead. Visibility itself is enforced by
// isCitizenRecordAssignee() (orgGates.js) at the API layer, exactly
// mirroring isCareTeamMember/isMatterTeamMember/isFundTeamMember: being a
// member of the same department is NOT enough on its own, only an actual
// assignment (or org owner/admin) grants access to a SPECIFIC record.
//
// Duplicate detection mirrors health-patients.js's exact honest heuristic
// (name + date of birth) — surfaces candidates for a human to review,
// never auto-merges.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { canAccessGovernment, isCitizenRecordAssignee } from "./orgGates.js";
import { logCitizenRecordAccess } from "./government-audit.js";

export const CITIZEN_RECORD_STATUSES = ["active", "archived"];

export async function findDuplicateCitizenRecordCandidates({ orgId, legalName, dateOfBirth }) {
  const { citizenRecords } = await getOrgCollections();
  if (!legalName || !dateOfBirth) return [];
  return citizenRecords
    .find({ orgId: toObjectId(orgId), deletedAt: null, legalName: { $regex: `^${legalName.trim()}$`, $options: "i" }, dateOfBirth })
    .toArray();
}

export async function createCitizenRecord({ orgId, legalName, preferredName, dateOfBirth, identifiers, contacts, demographics, department, classification, actorEmail, membership }) {
  if (!canAccessGovernment(membership)) return { error: "You don't have permission to create a citizen record.", status: 403 };
  if (!legalName?.trim()) return { error: "A legal name is required.", status: 400 };

  const { citizenRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), legalName: legalName.trim(), preferredName: preferredName || null, dateOfBirth: dateOfBirth || null,
    identifiers: identifiers || [], // e.g. [{type: "national_id", value, agency}] -- caller-defined shape, this module doesn't validate a specific national ID scheme
    contacts: contacts || [], demographics: demographics || {},
    department: department || null, status: "active",
    classification: classification || "REGULATED",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await citizenRecords.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logCitizenRecordAccess({ orgId, recordId: inserted._id, actorEmail, action: "CREATED", metadata: {} });
  return { record: inserted };
}

/** Assigns a member to a citizen record — the write side of the
 *  citizen_record_assignments join table isCitizenRecordAssignee() reads.
 *  Only a government manager (or org owner/admin) may assign; being
 *  assigned is what grants an ordinary staff member visibility into that
 *  SPECIFIC record, not the other way around (department membership or
 *  governmentRole:"staff" alone is never enough — SOW §C). */
export async function assignCitizenRecord({ orgId, recordId, memberEmail, role, actorEmail, membership }) {
  if (!canAccessGovernment(membership)) return { error: "You don't have permission to manage this record's assignments.", status: 403 };
  const { citizenRecordAssignments, citizenRecords } = await getOrgCollections();
  const record = await citizenRecords.findOne({ _id: toObjectId(recordId), orgId: toObjectId(orgId), deletedAt: null });
  if (!record) return { error: "Citizen record not found.", status: 404 };

  const now = new Date().toISOString();
  await citizenRecordAssignments.findOneAndUpdate(
    { orgId: toObjectId(orgId), recordId: toObjectId(recordId), email: memberEmail },
    { $set: { role: role || "member", updatedAt: now }, $setOnInsert: { createdAt: now, assignedByEmail: actorEmail } },
    { upsert: true }
  );
  await logCitizenRecordAccess({ orgId, recordId: record._id, actorEmail, action: "ASSIGNED", metadata: { memberEmail, role } });
  return { assigned: true };
}

export async function unassignCitizenRecord({ orgId, recordId, memberEmail, actorEmail, membership }) {
  if (!canAccessGovernment(membership)) return { error: "You don't have permission to manage this record's assignments.", status: 403 };
  const { citizenRecordAssignments } = await getOrgCollections();
  await citizenRecordAssignments.deleteOne({ orgId: toObjectId(orgId), recordId: toObjectId(recordId), email: memberEmail });
  await logCitizenRecordAccess({ orgId, recordId, actorEmail, action: "UNASSIGNED", metadata: { memberEmail } });
  return { unassigned: true };
}

async function getAssignments(orgId, recordId) {
  const { citizenRecordAssignments } = await getOrgCollections();
  return citizenRecordAssignments.find({ orgId: toObjectId(orgId), recordId: toObjectId(recordId) }).toArray();
}

/** THE load-bearing access check for this module: department membership
 *  or even governmentRole:"staff" is NOT enough — the caller must be a
 *  real, specific assignee of THIS record (or org owner/admin). Returns
 *  {record} or {error, status:403/404}. Every read/route that touches one
 *  specific citizen record's content should go through this, not
 *  canAccessGovernment() alone. */
export async function requireCitizenRecordAccess({ orgId, recordId, membership, actorEmail }) {
  if (!canAccessGovernment(membership)) return { error: "You don't have Government OS access.", status: 403 };
  const { citizenRecords } = await getOrgCollections();
  const record = await citizenRecords.findOne({ _id: toObjectId(recordId), orgId: toObjectId(orgId), deletedAt: null });
  if (!record) return { error: "Citizen record not found.", status: 404 };

  const assignments = await getAssignments(orgId, recordId);
  if (!isCitizenRecordAssignee(membership, recordId, assignments)) {
    return { error: "You're not assigned to this record — department membership alone doesn't grant access.", status: 403 };
  }

  await logCitizenRecordAccess({ orgId, recordId: record._id, actorEmail, action: "VIEWED", metadata: {} });
  return { record };
}

/** Human-reviewed merge, same discipline as health-patients.js's
 *  mergePatients(): never hard-deletes the duplicate, records the merge
 *  decision on the surviving record instead. */
export async function mergeCitizenRecords({ orgId, survivingRecordId, duplicateRecordId, actorEmail, membership }) {
  if (!canManageOrg(membership) && !canAccessGovernment(membership)) return { error: "You don't have permission to merge citizen records.", status: 403 };
  const { citizenRecords } = await getOrgCollections();
  const now = new Date().toISOString();

  const duplicate = await citizenRecords.findOneAndUpdate(
    { _id: toObjectId(duplicateRecordId), orgId: toObjectId(orgId), deletedAt: null },
    { $set: { deletedAt: now, mergedInto: toObjectId(survivingRecordId), mergedByEmail: actorEmail, mergedAt: now } },
    { returnDocument: "after" }
  );
  if (!duplicate) return { error: "Duplicate citizen record not found (or already merged).", status: 404 };

  await logCitizenRecordAccess({ orgId, recordId: duplicate._id, actorEmail, action: "MERGED", metadata: { survivingRecordId } });
  return { merged: duplicate };
}

/** List-level visibility (metadata only, never full record content) is
 *  governmentRole-gated, same as every other module's list endpoint — the
 *  stricter per-record content check is requireCitizenRecordAccess()
 *  above, called when a SPECIFIC record is actually opened. */
export async function listCitizenRecords(orgId, { status, department, membership } = {}) {
  if (!canAccessGovernment(membership)) return { error: "You don't have Government OS access.", status: 403 };
  const { citizenRecords } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), deletedAt: null };
  if (status) query.status = status;
  if (department) query.department = department;
  const records = await citizenRecords.find(query).sort({ createdAt: -1 }).toArray();
  // Metadata-only projection for the list view -- never the full record
  // (identifiers/demographics/contacts) until requireCitizenRecordAccess()
  // has actually confirmed this caller is assigned to that specific one.
  return { records: records.map((r) => ({ _id: r._id, legalName: r.legalName, status: r.status, department: r.department, classification: r.classification, createdAt: r.createdAt })) };
}
