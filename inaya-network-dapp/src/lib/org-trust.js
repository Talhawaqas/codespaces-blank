// src/lib/org-trust.js
//
// Institutional Trust Infrastructure SOW, Phase 5 — cross-organization
// trust primitives ONLY. Per the SOW's own scope limit ("focus initially
// on trust and authorization primitives, not new vertical applications"),
// this file builds propose/accept/reject/revoke/list/check on a new,
// self-contained collection and does NOT wire actual cross-org data
// access into any existing module — isTrustedAccess() is a query
// function any future feature could call, not something anything in this
// codebase calls yet. Wiring real data-sharing through it would mean
// touching every data-access path in the app, well beyond this pass.
//
// INDEPENDENT CONTROL (the SOW's explicit requirement): a relationship
// can only be proposed by a manager of the FROM org, and can only be
// accepted/rejected by a manager of the TO org — the org filter on every
// accept/reject call means an org can never accept its own outbound
// proposal, matching purchase-order-workflow.js's atomic
// findOneAndUpdate-with-status-guard convention for every other state
// machine in this codebase.
//
// EXPIRY: lazy, not cron-swept (kept out of scope for this pass, same as
// this codebase's PROPOSAL_EXPIRY_MS convention in spirit, but simpler) —
// listTrustRelationships/isTrustedAccess compute an effective status from
// expiresAt at read time rather than requiring a background sweep to keep
// stored status accurate.

import { getOrgCollections, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const TRUST_RELATIONSHIP_STATES = ["PENDING", "ACTIVE", "REJECTED", "REVOKED", "EXPIRED"];

function serialize(row) {
  if (!row) return null;
  const now = Date.now();
  const expired = row.status === "ACTIVE" && row.expiresAt && new Date(row.expiresAt).getTime() < now;
  return {
    relationshipId: row._id.toString(),
    fromOrgId: row.fromOrgId.toString(),
    toOrgId: row.toOrgId.toString(),
    scope: row.scope,
    purpose: row.purpose,
    expiresAt: row.expiresAt,
    status: expired ? "EXPIRED" : row.status,
    proposedByEmail: row.proposedByEmail,
    respondedByEmail: row.respondedByEmail,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** scope is a plain array of short strings the FROM org is willing to be
 *  asked about (e.g. ["evidence:read", "audit:verify"]) -- this file
 *  doesn't interpret them, it just stores and returns them; a future
 *  feature that actually shares data decides what its own scope strings
 *  mean. */
export async function proposeTrustRelationship({ fromOrgId, toOrgId, scope, purpose, expiresAt, membership, actorEmail }) {
  if (fromOrgId.toString() === toOrgId.toString()) return { error: "An organization can't propose a trust relationship with itself.", status: 400 };
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can propose a trust relationship.", status: 403 };
  if (!Array.isArray(scope) || scope.length === 0) return { error: "At least one scope string is required.", status: 400 };

  const { orgs, orgTrustRelationships } = await getOrgCollections();
  const toOrgObjectId = toObjectId(toOrgId);
  const targetOrg = await orgs.findOne({ _id: toOrgObjectId });
  if (!targetOrg) return { error: "The target organization doesn't exist.", status: 404 };

  const fromOrgObjectId = toObjectId(fromOrgId);
  const now = new Date().toISOString();
  const doc = {
    fromOrgId: fromOrgObjectId, toOrgId: toOrgObjectId, scope, purpose: purpose || "",
    expiresAt: expiresAt || null, status: "PENDING",
    proposedByEmail: actorEmail, respondedByEmail: null, respondedAt: null,
    createdAt: now, updatedAt: now,
  };
  const { insertedId } = await orgTrustRelationships.insertOne(doc);
  const row = { ...doc, _id: insertedId };

  await logOrgActivity({ orgId: fromOrgObjectId, recordType: "TRUST_RELATIONSHIP", recordId: insertedId, actorEmail, action: "TRUST_PROPOSED", previousState: null, newState: "PENDING", metadata: { toOrgId: toOrgId.toString(), scope } });
  return { relationship: serialize(row) };
}

async function respond({ relationshipId, toOrgId, membership, actorEmail, decision }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can respond to a trust proposal.", status: 403 };
  const { orgTrustRelationships } = await getOrgCollections();
  const relObjectId = toObjectId(relationshipId);
  const toOrgObjectId = toObjectId(toOrgId);
  const newStatus = decision === "accept" ? "ACTIVE" : "REJECTED";
  const now = new Date().toISOString();

  // The filter itself IS the independent-control guarantee: only a row
  // whose toOrgId matches the caller's own org (never fromOrgId) can be
  // matched here, so an org can never accept/reject its own outbound
  // proposal no matter what relationshipId it supplies.
  const updated = await orgTrustRelationships.findOneAndUpdate(
    { _id: relObjectId, toOrgId: toOrgObjectId, status: "PENDING" },
    { $set: { status: newStatus, respondedByEmail: actorEmail, respondedAt: now, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "No pending trust proposal found for this organization with that id.", status: 404 };

  await logOrgActivity({ orgId: toOrgObjectId, recordType: "TRUST_RELATIONSHIP", recordId: relObjectId, actorEmail, action: decision === "accept" ? "TRUST_ACCEPTED" : "TRUST_REJECTED", previousState: "PENDING", newState: newStatus, metadata: {} });
  return { relationship: serialize(updated) };
}

export async function acceptTrustRelationship({ relationshipId, toOrgId, membership, actorEmail }) {
  return respond({ relationshipId, toOrgId, membership, actorEmail, decision: "accept" });
}

export async function rejectTrustRelationship({ relationshipId, toOrgId, membership, actorEmail }) {
  return respond({ relationshipId, toOrgId, membership, actorEmail, decision: "reject" });
}

/** Either side may revoke, at any time while PENDING or ACTIVE. */
export async function revokeTrustRelationship({ relationshipId, orgId, membership, actorEmail }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can revoke a trust relationship.", status: 403 };
  const { orgTrustRelationships } = await getOrgCollections();
  const relObjectId = toObjectId(relationshipId);
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();

  const existing = await orgTrustRelationships.findOne({ _id: relObjectId });
  if (!existing) return { error: "Trust relationship not found.", status: 404 };
  if (existing.fromOrgId.toString() !== orgObjectId.toString() && existing.toOrgId.toString() !== orgObjectId.toString()) {
    return { error: "Trust relationship not found.", status: 404 };
  }

  const updated = await orgTrustRelationships.findOneAndUpdate(
    { _id: relObjectId, status: { $in: ["PENDING", "ACTIVE"] } },
    { $set: { status: "REVOKED", updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: `This trust relationship isn't PENDING/ACTIVE (it's currently ${existing.status}).`, status: 409 };

  await logOrgActivity({ orgId: orgObjectId, recordType: "TRUST_RELATIONSHIP", recordId: relObjectId, actorEmail, action: "TRUST_REVOKED", previousState: existing.status, newState: "REVOKED", metadata: {} });
  return { relationship: serialize(updated) };
}

/** Both directions -- an org's trust panel shows relationships it
 *  proposed AND relationships proposed to it. */
export async function listTrustRelationships({ orgId }) {
  const { orgTrustRelationships } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const rows = await orgTrustRelationships
    .find({ $or: [{ fromOrgId: orgObjectId }, { toOrgId: orgObjectId }] })
    .sort({ createdAt: -1 })
    .toArray();
  return { relationships: rows.map(serialize) };
}

/** Query-only primitive -- not called by any existing route this pass
 *  (see header comment). true only for an ACTIVE, unexpired relationship
 *  whose scope array includes the requested scope string. */
export async function isTrustedAccess({ fromOrgId, toOrgId, scope }) {
  const { orgTrustRelationships } = await getOrgCollections();
  const row = await orgTrustRelationships.findOne({
    fromOrgId: toObjectId(fromOrgId), toOrgId: toObjectId(toOrgId), status: "ACTIVE", scope,
  });
  if (!row) return { trusted: false };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return { trusted: false, reason: "expired" };
  return { trusted: true, relationshipId: row._id.toString() };
}
