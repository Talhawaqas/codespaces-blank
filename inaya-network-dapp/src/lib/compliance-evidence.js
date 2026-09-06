// src/lib/compliance-evidence.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§47) — the
// Evidence Vault. Evidence is always submitted against a control (or,
// less commonly, stands alone pending linkage) and carries its own
// review status independent of the control's overall effectiveness —
// a control can have five pieces of evidence, some approved, some
// rejected, some still pending; reviewEvidence() only ever changes ONE
// evidence row's status, never fabricates a rollup here (that rollup is
// compliance-health.js's job, and it must show "unknown" rather than
// invent a passing state for anything not actually reviewed).

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageCompliance, canAccessCompliance } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const EVIDENCE_TYPES = [
  "policy", "procedure", "screenshot", "configuration_export", "log", "audit_record",
  "access_review", "training_record", "incident_record", "vendor_assessment",
  "penetration_test", "vulnerability_scan", "backup_test", "disaster_recovery_test",
  "business_continuity_test", "approval", "meeting_minutes", "system_report",
];

export const EVIDENCE_REVIEW_STATUSES = ["pending", "approved", "rejected"];

export async function submitEvidence({ orgId, controlId, type, sourceRef, hash, validFrom, validUntil, classification, actorEmail, membership }) {
  if (!canAccessCompliance(membership)) return { error: "Only compliance staff or org owner/admin can submit evidence.", status: 403 };
  if (!EVIDENCE_TYPES.includes(type)) return { error: `Unknown evidence type "${type}".`, status: 400 };

  const { complianceEvidence } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    controlId: controlId ? toObjectId(controlId) : null,
    type,
    sourceRef: sourceRef || null,
    hash: hash || null,
    classification: classification || "CONFIDENTIAL",
    version: 1,
    reviewStatus: "pending",
    reviewerEmail: null,
    reviewedAt: null,
    validFrom: validFrom || now,
    validUntil: validUntil || null,
    submittedByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await complianceEvidence.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_EVIDENCE", recordId: inserted._id, actorEmail, action: "SUBMITTED", previousState: null, newState: "pending", metadata: { type, controlId: controlId || null } });
  return { evidence: inserted };
}

export async function reviewEvidence({ orgId, evidenceId, reviewStatus, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can review evidence.", status: 403 };
  if (!EVIDENCE_REVIEW_STATUSES.includes(reviewStatus) || reviewStatus === "pending") {
    return { error: `Evidence must be reviewed as "approved" or "rejected", not "${reviewStatus}".`, status: 400 };
  }

  const { complianceEvidence } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await complianceEvidence.findOneAndUpdate(
    { _id: toObjectId(evidenceId), orgId: toObjectId(orgId), reviewStatus: "pending" },
    { $set: { reviewStatus, reviewerEmail: actorEmail, reviewedAt: now, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const existing = await complianceEvidence.findOne({ _id: toObjectId(evidenceId), orgId: toObjectId(orgId) });
    if (!existing) return { error: "Evidence not found.", status: 404 };
    return { error: `This evidence was already reviewed (${existing.reviewStatus}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_EVIDENCE", recordId: updated._id, actorEmail, action: reviewStatus === "approved" ? "APPROVED" : "REJECTED", previousState: "pending", newState: reviewStatus, metadata: {} });
  return { evidence: updated };
}

export async function linkEvidenceToControl({ orgId, evidenceId, controlId, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can link evidence.", status: 403 };
  const { complianceEvidence } = await getOrgCollections();
  const updated = await complianceEvidence.findOneAndUpdate(
    { _id: toObjectId(evidenceId), orgId: toObjectId(orgId) },
    { $set: { controlId: toObjectId(controlId), updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Evidence not found.", status: 404 };
  return { evidence: updated };
}

export async function listEvidence(orgId, { controlId, reviewStatus } = {}) {
  const { complianceEvidence } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (controlId) query.controlId = toObjectId(controlId);
  if (reviewStatus) query.reviewStatus = reviewStatus;
  return complianceEvidence.find(query).sort({ createdAt: -1 }).toArray();
}

/** Evidence "expiring soon" — never mutated automatically. This is a read
 *  helper for the dashboard/notifications, not a cron that changes state;
 *  an expired-but-untouched row stays whatever reviewStatus it had, and
 *  compliance-health.js decides how to bucket it (never as "passing"). */
export async function listExpiringEvidence(orgId, { withinDays = 30 } = {}) {
  const { complianceEvidence } = await getOrgCollections();
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
  return complianceEvidence
    .find({ orgId: toObjectId(orgId), validUntil: { $ne: null, $lte: cutoff } })
    .sort({ validUntil: 1 })
    .toArray();
}
