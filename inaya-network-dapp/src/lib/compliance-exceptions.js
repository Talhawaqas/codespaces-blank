// src/lib/compliance-exceptions.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§127-128) —
// Compliance Exceptions / Risk Acceptance. The SOW is explicit: "No
// permanent silent exceptions" — enforced here by requiring expiresAt on
// every request (never optional, never null on ACTIVE) and by
// listExpiredExceptions() surfacing anything past its date for
// renewal/closure, mirroring retention.js's hold-checking style. Nothing
// in this file auto-transitions an exception to EXPIRED — that's a
// read-time computed fact for the dashboard/notifications to act on, not
// a state a cron silently flips (consistent with how compliance-evidence.js
// treats an expired-but-untouched row).

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageCompliance } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const EXCEPTION_STATES = ["REQUESTED", "APPROVED", "ACTIVE", "EXPIRED", "RENEWED", "CLOSED"];

export const EXCEPTION_TRANSITIONS = {
  approve: { from: "REQUESTED", to: "APPROVED", activityAction: "APPROVED" },
  activate: { from: "APPROVED", to: "ACTIVE", activityAction: "ACTIVATED" },
  renew: { from: "ACTIVE", to: "RENEWED", activityAction: "RENEWED" },
  close: { from: "ACTIVE", to: "CLOSED", activityAction: "CLOSED" },
};

export async function requestException({ orgId, linkedControlId, justification, compensatingControl, expiresAt, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can request an exception.", status: 403 };
  if (!justification?.trim()) return { error: "A justification is required.", status: 400 };
  if (!expiresAt) return { error: "An exception must have an expiry date — permanent silent exceptions aren't allowed.", status: 400 };

  const { complianceExceptions } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    linkedControlId: linkedControlId ? toObjectId(linkedControlId) : null,
    justification: justification.trim(),
    compensatingControl: compensatingControl || null,
    status: "REQUESTED",
    riskAcceptedByEmail: null,
    expiresAt,
    requestedByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await complianceExceptions.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_EXCEPTION", recordId: inserted._id, actorEmail, action: "REQUESTED", previousState: null, newState: "REQUESTED", metadata: { linkedControlId: linkedControlId || null } });
  return { exception: inserted };
}

export async function transitionException({ orgId, exceptionId, action, actorEmail, membership, expiresAt }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can update an exception.", status: 403 };
  const definition = EXCEPTION_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };
  if (action === "renew" && !expiresAt) return { error: "A renewal must set a new expiry date.", status: 400 };

  const { complianceExceptions } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const exceptionObjectId = toObjectId(exceptionId);
  const now = new Date().toISOString();

  const setDoc = { status: definition.to, updatedAt: now };
  if (action === "approve") setDoc.riskAcceptedByEmail = actorEmail;
  if (action === "renew") setDoc.expiresAt = expiresAt;

  const updated = await complianceExceptions.findOneAndUpdate(
    { _id: exceptionObjectId, orgId: orgObjectId, status: definition.from },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await complianceExceptions.findOne({ _id: exceptionObjectId, orgId: orgObjectId });
    if (!current) return { error: "Exception not found.", status: 404 };
    return { error: `This exception isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_EXCEPTION", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: {} });
  return { exception: updated };
}

export async function listExceptions(orgId, { status } = {}) {
  const { complianceExceptions } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return complianceExceptions.find(query).sort({ createdAt: -1 }).toArray();
}

/** Computed, read-only view — an ACTIVE exception past its expiresAt is
 *  "expired" for reporting purposes even though nothing has flipped its
 *  stored status yet; a human must still explicitly renew or close it. */
export async function listExpiredExceptions(orgId) {
  const { complianceExceptions } = await getOrgCollections();
  const now = new Date().toISOString();
  return complianceExceptions
    .find({ orgId: toObjectId(orgId), status: "ACTIVE", expiresAt: { $lte: now } })
    .sort({ expiresAt: 1 })
    .toArray();
}
