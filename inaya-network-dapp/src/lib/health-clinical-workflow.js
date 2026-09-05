// src/lib/health-clinical-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 2 (§10.6) — clinical
// documentation lifecycle: draft -> review -> sign -> lock -> amend/
// version. Same TRANSITIONS-map + atomic findOneAndUpdate pattern as
// document-workflow.js. A LOCKED record is never silently overwritten —
// "amend" doesn't mutate the locked record in place, it creates a new
// version row linked via `amendsRecordId`, exactly how document-workflow's
// sibling "revise" path never edits an already-reviewed document either.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessHealthRecords } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const CLINICAL_RECORD_STATES = ["DRAFT", "REVIEW", "SIGNED", "LOCKED", "AMENDED"];

export const CLINICAL_TRANSITIONS = {
  submitForReview: { from: "DRAFT", to: "REVIEW", activityAction: "SUBMITTED_FOR_REVIEW" },
  sign: { from: "REVIEW", to: "SIGNED", activityAction: "SIGNED" },
  lock: { from: "SIGNED", to: "LOCKED", activityAction: "LOCKED" },
};

export async function createClinicalRecord({ orgId, patientId, encounterId, recordTemplate, documentId, content, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to create a clinical record.", status: 403 };
  const { healthClinicalRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), patientId: toObjectId(patientId),
    encounterId: encounterId ? toObjectId(encounterId) : null,
    recordTemplate, documentId: documentId ? toObjectId(documentId) : null, content: content || null,
    status: "DRAFT", amendsRecordId: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, signedByEmail: null, signedAt: null,
  };
  const result = await healthClinicalRecords.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "CLINICAL_RECORD", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "DRAFT", metadata: { recordTemplate, patientId } });
  return { record: inserted };
}

export async function transitionClinicalRecord({ orgId, recordId, action, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to update this clinical record.", status: 403 };
  const definition = CLINICAL_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { healthClinicalRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const setFields = { status: definition.to, updatedAt: now };
  if (action === "sign") { setFields.signedByEmail = actorEmail; setFields.signedAt = now; }

  const updated = await healthClinicalRecords.findOneAndUpdate(
    { _id: toObjectId(recordId), orgId: toObjectId(orgId), status: definition.from },
    { $set: setFields },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await healthClinicalRecords.findOne({ _id: toObjectId(recordId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Clinical record not found.", status: 404 };
    return { error: `This record isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "CLINICAL_RECORD", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: {} });
  return { record: updated };
}

/** Amending a LOCKED record never mutates it in place — creates a brand
 *  new DRAFT record linking back via amendsRecordId, and marks the
 *  original's status AMENDED (a terminal state distinct from LOCKED, so
 *  a query for "the current version" can filter status != AMENDED). */
export async function amendClinicalRecord({ orgId, recordId, content, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to amend this clinical record.", status: 403 };
  const { healthClinicalRecords } = await getOrgCollections();
  const original = await healthClinicalRecords.findOne({ _id: toObjectId(recordId), orgId: toObjectId(orgId), status: "LOCKED" });
  if (!original) return { error: "Only a LOCKED record can be amended.", status: 409 };

  const now = new Date().toISOString();
  const amendedDoc = {
    orgId: original.orgId, patientId: original.patientId, encounterId: original.encounterId,
    recordTemplate: original.recordTemplate, documentId: null, content: content || original.content,
    status: "DRAFT", amendsRecordId: original._id,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, signedByEmail: null, signedAt: null,
  };
  const result = await healthClinicalRecords.insertOne(amendedDoc);
  await healthClinicalRecords.updateOne({ _id: original._id }, { $set: { status: "AMENDED", updatedAt: now } });

  await logOrgActivity({ orgId, recordType: "CLINICAL_RECORD", recordId: original._id, actorEmail, action: "AMENDED", previousState: "LOCKED", newState: "AMENDED", metadata: { newRecordId: result.insertedId } });
  return { amendedRecord: { ...amendedDoc, _id: result.insertedId } };
}

export async function listClinicalRecordsForPatient(orgId, patientId) {
  const { healthClinicalRecords } = await getOrgCollections();
  return healthClinicalRecords.find({ orgId: toObjectId(orgId), patientId: toObjectId(patientId) }).sort({ createdAt: -1 }).toArray();
}
