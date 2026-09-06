// src/lib/compliance-policies.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§49) — Policy
// Management: authored policy DOCUMENTS with a versioned lifecycle. This
// is deliberately separate from the existing policy-engine.js, which is a
// point-of-action gating engine (download/export/share decisions) with no
// versioning or publish-immutability concept — confirmed via codebase
// audit that overloading one file with both jobs would conflate two
// different things called "policy." Nothing here calls or is called by
// policy-engine.js.
//
// The load-bearing property (SOW §49: "Policies must be immutable after
// publication except through versioned amendment") is enforced
// structurally, not by convention: there is NO updatePolicy() function
// that can touch a PUBLISHED document's content. amendPolicy() is the
// only path forward from a published policy, and it always inserts a
// NEW document at version+1 — it never mutates the row that IS published.
// A permanent test (test/compliance-policies.test.mjs) asserts this
// directly: publish, then confirm no code path can alter that same row.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageCompliance } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const POLICY_LIFECYCLE_STATES = ["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "AMENDED", "EXPIRED"];

export const POLICY_TRANSITIONS = {
  submitForReview: { from: "DRAFT", to: "IN_REVIEW", activityAction: "SUBMITTED_FOR_REVIEW" },
  approve: { from: "IN_REVIEW", to: "APPROVED", activityAction: "APPROVED" },
  reject: { from: "IN_REVIEW", to: "DRAFT", activityAction: "REJECTED" },
};

export async function createPolicyDraft({ orgId, key, title, body, ownerEmail, reviewCycleDays, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can author a policy.", status: 403 };
  if (!key?.trim() || !title?.trim()) return { error: "A policy key and title are required.", status: 400 };

  const { compliancePolicies } = await getOrgCollections();
  const existingLatest = await compliancePolicies.find({ orgId: toObjectId(orgId), key: key.trim() }).sort({ version: -1 }).limit(1).toArray();
  if (existingLatest.length > 0) {
    return { error: `A policy with key "${key.trim()}" already exists (v${existingLatest[0].version}). Use amendPolicy() to create a new version instead.`, status: 409 };
  }

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    key: key.trim(),
    version: 1,
    title: title.trim(),
    body: body || "",
    ownerEmail: ownerEmail || actorEmail,
    reviewCycleDays: reviewCycleDays || null,
    status: "DRAFT",
    immutable: false,
    effectiveDate: null,
    expiresAt: null,
    supersedes: null,
    approvedByEmail: null,
    approvedAt: null,
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await compliancePolicies.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_POLICY", recordId: inserted._id, actorEmail, action: "DRAFTED", previousState: null, newState: "DRAFT", metadata: { key: doc.key, version: 1 } });
  return { policy: inserted };
}

/** Only reachable while status is DRAFT or IN_REVIEW (the atomic
 *  findOneAndUpdate's own status:{$in:[...]} filter is what makes this
 *  actually enforced, not just documented) — a policy that has ever been
 *  PUBLISHED can never take this path again. */
export async function updatePolicyDraft({ orgId, policyId, title, body, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can edit a policy draft.", status: 403 };
  const { compliancePolicies } = await getOrgCollections();
  const setDoc = { updatedAt: new Date().toISOString() };
  if (title !== undefined) setDoc.title = title;
  if (body !== undefined) setDoc.body = body;

  const updated = await compliancePolicies.findOneAndUpdate(
    { _id: toObjectId(policyId), orgId: toObjectId(orgId), status: { $in: ["DRAFT", "IN_REVIEW"] } },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await compliancePolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Policy not found.", status: 404 };
    return { error: `This policy is ${current.status} and can no longer be edited directly — use amendPolicy() to create a new version.`, status: 409 };
  }
  return { policy: updated };
}

export async function transitionPolicy({ orgId, policyId, action, actorEmail, membership, note }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can update a policy.", status: 403 };
  const definition = POLICY_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { compliancePolicies } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const policyObjectId = toObjectId(policyId);
  const now = new Date().toISOString();

  const setDoc = { status: definition.to, updatedAt: now };
  if (action === "approve") { setDoc.approvedByEmail = actorEmail; setDoc.approvedAt = now; }

  const updated = await compliancePolicies.findOneAndUpdate(
    { _id: policyObjectId, orgId: orgObjectId, status: definition.from },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await compliancePolicies.findOne({ _id: policyObjectId, orgId: orgObjectId });
    if (!current) return { error: "Policy not found.", status: 404 };
    return { error: `This policy isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_POLICY", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  return { policy: updated };
}

/** The one and only path from APPROVED to live: sets immutable:true and
 *  an effectiveDate. From this point on, no function in this file can
 *  alter this document's title/body/status — only amendPolicy() (below)
 *  can supersede it, by inserting a NEW row. */
export async function publishPolicy({ orgId, policyId, effectiveDate, expiresAt, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can publish a policy.", status: 403 };
  const { compliancePolicies } = await getOrgCollections();
  const now = new Date().toISOString();

  const updated = await compliancePolicies.findOneAndUpdate(
    { _id: toObjectId(policyId), orgId: toObjectId(orgId), status: "APPROVED" },
    { $set: { status: "PUBLISHED", immutable: true, effectiveDate: effectiveDate || now, expiresAt: expiresAt || null, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await compliancePolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Policy not found.", status: 404 };
    return { error: `Only an APPROVED policy can be published (this one is ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_POLICY", recordId: updated._id, actorEmail, action: "PUBLISHED", previousState: "APPROVED", newState: "PUBLISHED", metadata: { effectiveDate: updated.effectiveDate } });
  return { policy: updated };
}

/** Creates a brand-new DRAFT document at version+1, linked via
 *  `supersedes`, and marks the currently-published row AMENDED (its
 *  content is still untouched and still readable for historical audit
 *  context — only its status field changes). This is the ONLY way to
 *  change a published policy's content. */
export async function amendPolicy({ orgId, policyId, title, body, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can amend a policy.", status: 403 };
  const { compliancePolicies } = await getOrgCollections();
  const current = await compliancePolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Policy not found.", status: 404 };
  if (current.status !== "PUBLISHED") return { error: `Only a PUBLISHED policy can be amended (this one is ${current.status}).`, status: 409 };

  const now = new Date().toISOString();
  const newDoc = {
    orgId: current.orgId,
    key: current.key,
    version: current.version + 1,
    title: title !== undefined ? title : current.title,
    body: body !== undefined ? body : current.body,
    ownerEmail: current.ownerEmail,
    reviewCycleDays: current.reviewCycleDays,
    status: "DRAFT",
    immutable: false,
    effectiveDate: null,
    expiresAt: null,
    supersedes: current._id,
    approvedByEmail: null,
    approvedAt: null,
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await compliancePolicies.insertOne(newDoc);
  const inserted = { ...newDoc, _id: result.insertedId };

  await compliancePolicies.updateOne({ _id: current._id }, { $set: { status: "AMENDED", updatedAt: now } });

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_POLICY", recordId: inserted._id, actorEmail, action: "AMENDMENT_DRAFTED", previousState: "PUBLISHED", newState: "DRAFT", metadata: { key: current.key, newVersion: inserted.version, supersedes: current._id } });
  return { policy: inserted };
}

export async function recordAcknowledgement({ orgId, policyId, memberEmail, actorEmail }) {
  const { compliancePolicyAcknowledgements } = await getOrgCollections();
  const now = new Date().toISOString();
  await compliancePolicyAcknowledgements.updateOne(
    { orgId: toObjectId(orgId), policyId: toObjectId(policyId), memberEmail },
    { $setOnInsert: { orgId: toObjectId(orgId), policyId: toObjectId(policyId), memberEmail, acknowledgedAt: now, recordedByEmail: actorEmail } },
    { upsert: true }
  );
  return { acknowledged: true };
}

export async function listPolicies(orgId, { status, key } = {}) {
  const { compliancePolicies } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (key) query.key = key;
  return compliancePolicies.find(query).sort({ key: 1, version: -1 }).toArray();
}

export async function listExpiringPolicies(orgId, { withinDays = 30 } = {}) {
  const { compliancePolicies } = await getOrgCollections();
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
  return compliancePolicies
    .find({ orgId: toObjectId(orgId), status: "PUBLISHED", expiresAt: { $ne: null, $lte: cutoff } })
    .sort({ expiresAt: 1 })
    .toArray();
}
