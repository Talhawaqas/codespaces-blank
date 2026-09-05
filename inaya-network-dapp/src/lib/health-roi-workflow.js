// src/lib/health-roi-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 3 (§10.19) — Release of
// Information: request -> authorization -> review -> approval -> export
// -> delivery -> audit. Reuses export-center.js's approval/generated/
// downloaded states for the export tail-end of this workflow rather than
// re-implementing that lifecycle — an ROI request creates its own record
// (tracking requester/patient/purpose/recipient, which export_requests
// has no fields for) but its actual package generation defers to
// export-center.js's requestExport/decideExport/markExportGenerated once
// authorization+review have passed, linked via `exportRequestId`.
//
// "Minimum-necessary" (§10.19) is enforced by requiring an explicit
// `requestedRecordIds` list rather than a blanket "all records for this
// patient" — the reviewer approves exactly the records named, not
// everything the patient has.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessHealthRecords, canManageHealth } from "./orgGates.js";
import { logConsentChange } from "./health-audit.js";
import { requestExport, decideExport } from "./export-center.js";

export const ROI_STATES = ["REQUESTED", "AUTHORIZED", "UNDER_REVIEW", "APPROVED", "REJECTED", "EXPORTED", "DELIVERED"];

export async function requestReleaseOfInformation({ orgId, patientId, requestedByEmail, requestedRecordIds, purpose, recipient, expiryDate, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to submit a release-of-information request.", status: 403 };
  const { healthRoiRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), patientId: toObjectId(patientId), requestedByEmail: requestedByEmail || actorEmail,
    requestedRecordIds: (requestedRecordIds || []).map((id) => toObjectId(id)), purpose,
    recipient: recipient || {}, expiryDate: expiryDate || null,
    status: "REQUESTED", reviewerEmail: null, exportRequestId: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await healthRoiRequests.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logConsentChange({ orgId, patientId, actorEmail, action: "ROI_REQUESTED", metadata: { purpose } });
  return { roiRequest: inserted };
}

export async function authorizeReleaseOfInformation({ orgId, roiRequestId, actorEmail, membership }) {
  if (!canManageHealth(membership)) return { error: "Only a health manager or the owner/admin can authorize a release request.", status: 403 };
  const { healthRoiRequests } = await getOrgCollections();
  const updated = await healthRoiRequests.findOneAndUpdate(
    { _id: toObjectId(roiRequestId), orgId: toObjectId(orgId), status: "REQUESTED" },
    { $set: { status: "AUTHORIZED", updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Request not found, or not in REQUESTED state.", status: 409 };
  return { roiRequest: updated };
}

export async function reviewReleaseOfInformation({ orgId, roiRequestId, approve, reviewerEmail, actorEmail, membership }) {
  if (!canManageHealth(membership)) return { error: "Only a health manager or the owner/admin can review a release request.", status: 403 };
  const { healthRoiRequests } = await getOrgCollections();
  const toStatus = approve ? "APPROVED" : "REJECTED";
  const updated = await healthRoiRequests.findOneAndUpdate(
    { _id: toObjectId(roiRequestId), orgId: toObjectId(orgId), status: { $in: ["AUTHORIZED", "UNDER_REVIEW"] } },
    { $set: { status: toStatus, reviewerEmail: reviewerEmail || actorEmail, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Request not found, or not ready for review.", status: 409 };

  if (approve) {
    // Hands off to export-center.js's own workflow for the actual package
    // — a real approved export_requests row is created AND immediately
    // marked approved, since a health manager reviewing an ROI request
    // has already exercised the authority export-center's decideExport
    // would otherwise separately require.
    const { request } = await requestExport({ orgId, reason: `ROI: ${updated.purpose}`, scope: { patientId: updated.patientId, recordIds: updated.requestedRecordIds }, format: "pdf", actorEmail });
    await decideExport({ orgId, requestId: request._id, approve: true, actorEmail, membership });
    await healthRoiRequests.updateOne({ _id: updated._id }, { $set: { exportRequestId: request._id } });
  }
  await logConsentChange({ orgId, patientId: updated.patientId, actorEmail, action: `ROI_${toStatus}`, metadata: {} });
  return { roiRequest: await healthRoiRequests.findOne({ _id: updated._id }) };
}

export async function listRoiRequestsForPatient(orgId, patientId) {
  const { healthRoiRequests } = await getOrgCollections();
  return healthRoiRequests.find({ orgId: toObjectId(orgId), patientId: toObjectId(patientId) }).sort({ createdAt: -1 }).toArray();
}
