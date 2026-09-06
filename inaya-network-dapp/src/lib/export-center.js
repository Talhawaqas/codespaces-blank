// src/lib/export-center.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§9) — shared Export Center.
// High-risk exports require approval (owner/admin), matching
// policy-engine.js's default "require_approval" verdict for the "export"
// action. This module is the request/approval/package/expire lifecycle;
// the actual package generation (zipping documents, redacting per
// classification, etc.) is intentionally left to each call site (a
// healthcare ROI export and a legal discovery production package need
// very different packaging logic) — this owns only the workflow and audit
// trail around that packaging step, not the packaging itself.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const EXPORT_STATES = ["REQUESTED", "APPROVED", "REJECTED", "GENERATED", "DOWNLOADED", "EXPIRED"];

export async function requestExport({ orgId, reason, scope, format, requiresDualControl, actorEmail }) {
  const { exportRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), reason, scope: scope || {}, format,
    status: "REQUESTED", requestedByEmail: actorEmail,
    approvedByEmail: null, packageUrl: null, expiresAt: null,
    // Financial Services & Regulated Enterprise SOW, Phase 4 (§94, §107)
    // — an optional dual-control gate for high-risk exports (an Audit
    // Package / Regulatory Examination export). Default false so every
    // existing single-approval caller is unaffected.
    requiresDualControl: !!requiresDualControl,
    secondApproverEmail: null,
    createdAt: now, updatedAt: now,
  };
  const result = await exportRequests.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "EXPORT_REQUEST", recordId: inserted._id, actorEmail, action: "REQUESTED", previousState: null, newState: "REQUESTED", metadata: { reason, format } });
  await createNotification({
    scope: "org", orgId, targetEmail: null, category: "approval", severity: "info",
    type: "export_requested", title: "Export request awaiting approval", body: reason,
    sourceModule: "export-center", sourceId: inserted._id, actionUrl: "/business?view=trustCenter",
    dedupeKey: `${orgId}:export_requested:${inserted._id}`,
  });
  return { request: inserted };
}

export async function decideExport({ orgId, requestId, approve, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can decide an export request.", status: 403 };
  const { exportRequests } = await getOrgCollections();
  const requestObjectId = toObjectId(requestId);
  const orgObjectId = toObjectId(orgId);

  if (approve) {
    const request = await exportRequests.findOne({ _id: requestObjectId, orgId: orgObjectId, status: "REQUESTED" });
    if (!request) return { error: "This export request has already been decided.", status: 409 };
    if (request.requiresDualControl) {
      // First of two required approvals: record it, but stay REQUESTED —
      // decideExportSecondApproval() below is the only path to APPROVED.
      const updated = await exportRequests.findOneAndUpdate(
        { _id: requestObjectId, orgId: orgObjectId, status: "REQUESTED", approvedByEmail: null },
        { $set: { approvedByEmail: actorEmail, updatedAt: new Date().toISOString() } },
        { returnDocument: "after" }
      );
      if (!updated) return { error: "This export request already has a first approval.", status: 409 };
      await logOrgActivity({ orgId, recordType: "EXPORT_REQUEST", recordId: updated._id, actorEmail, action: "FIRST_APPROVAL", previousState: "REQUESTED", newState: "REQUESTED", metadata: {} });
      return { request: updated };
    }
  }

  const toState = approve ? "APPROVED" : "REJECTED";
  const updated = await exportRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: "REQUESTED" },
    { $set: { status: toState, approvedByEmail: actorEmail, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This export request has already been decided.", status: 409 };

  await logOrgActivity({ orgId, recordType: "EXPORT_REQUEST", recordId: updated._id, actorEmail, action: toState, previousState: "REQUESTED", newState: toState, metadata: {} });
  return { request: updated };
}

/** The second of two required approvals for a dual-control export
 *  (SOW §94's "Approver A ≠ Approver B") — only reachable once
 *  decideExport() has recorded a first approval, and only by a DIFFERENT
 *  person than that first approver. */
export async function decideExportSecondApproval({ orgId, requestId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can give a second export approval.", status: 403 };
  const { exportRequests } = await getOrgCollections();
  const requestObjectId = toObjectId(requestId);
  const orgObjectId = toObjectId(orgId);

  const request = await exportRequests.findOne({ _id: requestObjectId, orgId: orgObjectId });
  if (!request) return { error: "Export request not found.", status: 404 };
  if (!request.requiresDualControl) return { error: "This export request doesn't require dual control.", status: 400 };
  if (request.status !== "REQUESTED" || !request.approvedByEmail) return { error: "This export request needs a first approval before a second one can be given.", status: 409 };
  if (request.approvedByEmail === actorEmail) return { error: "The second approver must be a different person than the first approver.", status: 403 };

  const updated = await exportRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: "REQUESTED", approvedByEmail: request.approvedByEmail, secondApproverEmail: null },
    { $set: { status: "APPROVED", secondApproverEmail: actorEmail, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This export request has already been decided.", status: 409 };

  await logOrgActivity({ orgId, recordType: "EXPORT_REQUEST", recordId: updated._id, actorEmail, action: "APPROVED", previousState: "REQUESTED", newState: "APPROVED", metadata: { dualControl: true } });
  return { request: updated };
}

/** Called by the vertical-specific packaging call site once it has
 *  actually generated the package. `expiresInDays` defaults to 7 — a
 *  generated export package shouldn't be downloadable indefinitely. */
export async function markExportGenerated({ orgId, requestId, packageUrl, actorEmail, expiresInDays = 7 }) {
  const { exportRequests } = await getOrgCollections();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const updated = await exportRequests.findOneAndUpdate(
    { _id: toObjectId(requestId), orgId: toObjectId(orgId), status: "APPROVED" },
    { $set: { status: "GENERATED", packageUrl, expiresAt, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Export request must be APPROVED before it can be generated.", status: 409 };
  await logOrgActivity({ orgId, recordType: "EXPORT_REQUEST", recordId: updated._id, actorEmail, action: "GENERATED", previousState: "APPROVED", newState: "GENERATED", metadata: {} });
  return { request: updated };
}

export async function markExportDownloaded({ orgId, requestId, actorEmail }) {
  const { exportRequests } = await getOrgCollections();
  const updated = await exportRequests.findOneAndUpdate(
    { _id: toObjectId(requestId), orgId: toObjectId(orgId), status: "GENERATED" },
    { $set: { status: "DOWNLOADED", updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (updated) {
    await logOrgActivity({ orgId, recordType: "EXPORT_REQUEST", recordId: updated._id, actorEmail, action: "DOWNLOADED", previousState: "GENERATED", newState: "DOWNLOADED", metadata: {} });
  }
  return { request: updated };
}

export async function listExportRequests(orgId, { status } = {}) {
  const { exportRequests } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return exportRequests.find(query).sort({ createdAt: -1 }).toArray();
}
