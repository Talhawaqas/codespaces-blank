// src/lib/retention.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.9) — retention / records
// management. `isUnderLegalHold()` is written now, in Phase 1, even though
// the legal_holds collection itself isn't populated until Phase 7 — this
// is deliberate: querying a collection that has no matching documents yet
// (or doesn't exist yet) is a completely safe, correct "no hold" result in
// Mongo, so every deletion call site across the app can start calling this
// guard from Phase 1 onward, and it starts actually blocking deletions the
// moment Phase 7's legal-hold-workflow.js begins writing real holds — no
// second wiring pass needed later.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";

export async function upsertRetentionPolicy({ orgId, recordType, retentionPeriodDays, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can set retention policy.", status: 403 };
  const { retentionPolicies } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await retentionPolicies.findOneAndUpdate(
    { orgId: toObjectId(orgId), recordType },
    { $set: { retentionPeriodDays, updatedByEmail: actorEmail, updatedAt: now }, $setOnInsert: { orgId: toObjectId(orgId), recordType, createdAt: now } },
    { upsert: true, returnDocument: "after" }
  );
  return { policy: updated };
}

export async function getRetentionPolicy(orgId, recordType) {
  const { retentionPolicies } = await getOrgCollections();
  return retentionPolicies.findOne({ orgId: toObjectId(orgId), recordType });
}

/** The guard every deletion/disposition call site should check first.
 *  `legal_holds` (Phase 7) holds records shaped
 *  {orgId, scope: "matter"|"custodian"|"record", matterId?, custodianEmail?,
 *  recordType?, recordId?, status: "ACTIVE"|"RELEASED"}. A record is
 *  under hold if ANY active hold matches it by direct recordId, OR by
 *  matter (if the record belongs to a held matter), OR by custodian (if
 *  the record's owner/custodian is a held custodian) — checked broadly
 *  here so Phase 7 doesn't need to touch this function again once it adds
 *  those richer scopes; the query already covers all three shapes. */
export async function isUnderLegalHold({ orgId, recordType, recordId, matterId, custodianEmail }) {
  const { db } = await getOrgCollections();
  const legalHolds = db.collection("legal_holds");
  const orConditions = [];
  if (recordType && recordId) orConditions.push({ recordType, recordId: toObjectId(recordId) });
  if (matterId) orConditions.push({ matterId: toObjectId(matterId) });
  if (custodianEmail) orConditions.push({ custodianEmail });
  if (!orConditions.length) return false;

  const match = await legalHolds.findOne({ orgId: toObjectId(orgId), status: "ACTIVE", $or: orConditions });
  return !!match;
}

/** Disposition guard used by any "actually delete this" call site.
 *  Returns {allowed:true} or {allowed:false, reason}. Never throws — a
 *  caller should treat a thrown error from the DB itself as fail-closed
 *  (i.e. don't delete), which is the caller's existing try/catch
 *  responsibility, not this function's. */
export async function checkDispositionAllowed({ orgId, recordType, recordId, matterId, custodianEmail }) {
  const held = await isUnderLegalHold({ orgId, recordType, recordId, matterId, custodianEmail });
  if (held) return { allowed: false, reason: "This record is under an active legal hold and cannot be deleted." };

  const policy = await getRetentionPolicy(orgId, recordType);
  if (policy?.requiresDispositionApproval) {
    return { allowed: false, reason: "This record type requires disposition approval before deletion.", requiresApproval: true };
  }
  return { allowed: true };
}
