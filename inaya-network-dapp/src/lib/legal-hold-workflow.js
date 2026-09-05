// src/lib/legal-hold-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 7 (§11.13) — legal holds.
// Lifecycle: creation -> notice -> acknowledgement -> preservation ->
// (exceptions) -> release -> release-approval. This is the collection
// retention.js's isUnderLegalHold()/checkDispositionAllowed() query
// directly (Phase 1 wrote that guard against exactly this schema ahead of
// time) — a hold created here immediately starts blocking disposition at
// every call site that checks checkDispositionAllowed() first, with zero
// additional wiring needed on retention.js's side.
//
// scope: "matter" | "custodian" | "record" — matches retention.js's
// isUnderLegalHold() OR-condition shape exactly.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters, canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const HOLD_STATES = ["ACTIVE", "RELEASED"];

export async function createLegalHold({ orgId, matterId, scope, custodianEmails, recordType, recordId, reason, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to create a legal hold.", status: 403 };
  if (!["matter", "custodian", "record"].includes(scope)) return { error: `Unknown hold scope "${scope}".`, status: 400 };

  const { legalHolds } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: matterId ? toObjectId(matterId) : null, scope,
    custodianEmails: custodianEmails || [], recordType: recordType || null, recordId: recordId ? toObjectId(recordId) : null,
    reason: reason || "", status: "ACTIVE",
    notices: [], acknowledgements: [], exceptions: [],
    releasedAt: null, releasedByEmail: null, releaseApprovedByEmail: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalHolds.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "LEGAL_HOLD", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "ACTIVE", metadata: { scope, matterId } });

  // Notice — SOW's own next lifecycle step, sent immediately on creation.
  await Promise.all(
    (custodianEmails || []).map((custodianEmail) =>
      createNotification({
        scope: "org", orgId, targetEmail: custodianEmail, category: "compliance_control", severity: "critical",
        type: "legal_hold_notice", title: "Legal hold notice", body: reason || "You are subject to a legal hold — do not delete or alter related records.",
        sourceModule: "legal-hold-workflow", sourceId: inserted._id, actionUrl: "/business?view=legal",
        dedupeKey: `${orgId}:legal_hold_notice:${inserted._id}:${custodianEmail}`,
      })
    )
  );
  return { hold: inserted };
}

export async function acknowledgeLegalHold({ orgId, holdId, actorEmail }) {
  const { legalHolds } = await getOrgCollections();
  const updated = await legalHolds.findOneAndUpdate(
    { _id: toObjectId(holdId), orgId: toObjectId(orgId), status: "ACTIVE" },
    { $push: { acknowledgements: { email: actorEmail, at: new Date().toISOString() } }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Hold not found, or already released.", status: 404 };
  await logOrgActivity({ orgId, recordType: "LEGAL_HOLD", recordId: updated._id, actorEmail, action: "ACKNOWLEDGED", previousState: null, newState: null, metadata: {} });
  return { hold: updated };
}

/** An exception is a documented, reviewed carve-out (e.g. a specific
 *  record within a matter-wide hold that's confirmed irrelevant) — it
 *  narrows what the hold's own OR-conditions in retention.js would match
 *  by simply not creating a matching hold row for that narrower scope in
 *  the first place; recorded here for audit visibility of the decision,
 *  not as a field retention.js's query needs to special-case. */
export async function recordHoldException({ orgId, holdId, description, approvedByEmail, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can approve a hold exception.", status: 403 };
  const { legalHolds } = await getOrgCollections();
  const updated = await legalHolds.findOneAndUpdate(
    { _id: toObjectId(holdId), orgId: toObjectId(orgId), status: "ACTIVE" },
    { $push: { exceptions: { description, approvedByEmail: approvedByEmail || actorEmail, at: new Date().toISOString() } }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Hold not found, or already released.", status: 404 };
  return { hold: updated };
}

/** Release requires manager/owner/admin authority — releasing a hold is
 *  what re-enables ordinary disposition on the held records, so this is
 *  deliberately a higher bar than creating one. */
export async function releaseLegalHold({ orgId, holdId, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can release a legal hold.", status: 403 };
  const { legalHolds } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await legalHolds.findOneAndUpdate(
    { _id: toObjectId(holdId), orgId: toObjectId(orgId), status: "ACTIVE" },
    { $set: { status: "RELEASED", releasedAt: now, releasedByEmail: actorEmail, releaseApprovedByEmail: actorEmail, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Hold not found, or already released.", status: 409 };
  await logOrgActivity({ orgId, recordType: "LEGAL_HOLD", recordId: updated._id, actorEmail, action: "RELEASED", previousState: "ACTIVE", newState: "RELEASED", metadata: {} });
  return { hold: updated };
}

export async function listLegalHolds(orgId, { status } = {}) {
  const { legalHolds } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return legalHolds.find(query).sort({ createdAt: -1 }).toArray();
}
