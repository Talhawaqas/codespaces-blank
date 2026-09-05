// src/lib/legal-time-tracking.js
//
// Healthcare & Legal Expansion SOW, Phase 8 (§11.23) — time tracking.
// Genuinely new: confirmed via codebase audit that no billing-rate or
// time-entry concept exists anywhere in the existing invoice/expense
// layer. A time entry moves DRAFT -> SUBMITTED -> APPROVED -> LOCKED
// (locked once billed, matching the "never silently overwrite a billed
// record" discipline every other lifecycle in this SOW follows) or
// -> REJECTED, back to DRAFT for correction.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters, canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const TIME_ENTRY_STATES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "LOCKED"];

export async function createTimeEntry({ orgId, matterId, lawyerEmail, taskDescription, minutes, billable, rate, entryDate, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to log time.", status: 403 };
  const { legalTimeEntries } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), lawyerEmail: lawyerEmail || actorEmail,
    taskDescription: taskDescription || "", minutes, billable: billable !== false, rate: rate || null,
    entryDate: entryDate || now, status: "DRAFT", billed: false,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalTimeEntries.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "TIME_ENTRY", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "DRAFT", metadata: { matterId, minutes } });
  return { timeEntry: inserted };
}

export async function submitTimeEntry({ orgId, timeEntryId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to submit this time entry.", status: 403 };
  const { legalTimeEntries } = await getOrgCollections();
  const updated = await legalTimeEntries.findOneAndUpdate(
    { _id: toObjectId(timeEntryId), orgId: toObjectId(orgId), status: "DRAFT" },
    { $set: { status: "SUBMITTED", updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Time entry not found, or not in DRAFT state.", status: 409 };
  await logOrgActivity({ orgId, recordType: "TIME_ENTRY", recordId: updated._id, actorEmail, action: "SUBMITTED", previousState: "DRAFT", newState: "SUBMITTED", metadata: {} });
  return { timeEntry: updated };
}

export async function decideTimeEntry({ orgId, timeEntryId, approve, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can approve time entries.", status: 403 };
  const { legalTimeEntries } = await getOrgCollections();
  const toStatus = approve ? "APPROVED" : "REJECTED";
  const updated = await legalTimeEntries.findOneAndUpdate(
    { _id: toObjectId(timeEntryId), orgId: toObjectId(orgId), status: "SUBMITTED" },
    { $set: { status: toStatus, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Time entry not found, or not in SUBMITTED state.", status: 409 };
  await logOrgActivity({ orgId, recordType: "TIME_ENTRY", recordId: updated._id, actorEmail, action: toStatus, previousState: "SUBMITTED", newState: toStatus, metadata: {} });
  return { timeEntry: updated };
}

/** Called by legal-billing-workflow.js once a time entry has actually
 *  been included on an invoice — locks it so it can never be billed
 *  twice or edited after billing, without deleting the record. */
export async function lockTimeEntryAsBilled({ orgId, timeEntryId }) {
  const { legalTimeEntries } = await getOrgCollections();
  return legalTimeEntries.findOneAndUpdate(
    { _id: toObjectId(timeEntryId), orgId: toObjectId(orgId), status: "APPROVED", billed: false },
    { $set: { status: "LOCKED", billed: true, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
}

export async function listUnbilledApprovedTimeEntries(orgId, matterId) {
  const { legalTimeEntries } = await getOrgCollections();
  return legalTimeEntries.find({ orgId: toObjectId(orgId), matterId: toObjectId(matterId), status: "APPROVED", billed: false }).sort({ entryDate: 1 }).toArray();
}
