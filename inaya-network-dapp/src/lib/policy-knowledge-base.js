// src/lib/policy-knowledge-base.js
//
// Government & Public Sector Sovereign OS SOW, Phase 1 (§4 "Policy
// Knowledge Base"). Deliberately reuses compliance-policies.js's exact
// DRAFT -> IN_REVIEW -> APPROVED -> PUBLISHED -> AMENDED -> EXPIRED
// versioned, publish-immutable lifecycle, recontextualized for government
// policy documents rather than compliance policies -- a thin, separate
// module (not compliance-policies.js extended in place) since the two are
// conceptually distinct catalogs an org may run independently of each
// other, same reasoning compliance-policies.js's own header gives for
// staying separate from policy-engine.js.
//
// THE LOAD-BEARING PROPERTY (same as compliance-policies.js): there is NO
// updateEntry() function that can touch a PUBLISHED document's content.
// amendEntry() is the only path forward from a published entry, and it
// always inserts a NEW document at version+1 -- it never mutates the row
// that IS published. test/policy-knowledge-base.test.mjs asserts this
// directly, written before this implementation, per this SOW's own
// verification requirement.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessGovernment, canManageGovernment } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const POLICY_KB_STATES = ["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "AMENDED", "EXPIRED"];

export const POLICY_KB_TRANSITIONS = {
  submitForReview: { from: "DRAFT", to: "IN_REVIEW", activityAction: "SUBMITTED_FOR_REVIEW" },
  approve: { from: "IN_REVIEW", to: "APPROVED", activityAction: "APPROVED" },
  reject: { from: "IN_REVIEW", to: "DRAFT", activityAction: "REJECTED" },
};

export async function createEntryDraft({ orgId, key, title, body, ownerEmail, reviewCycleDays, actorEmail, membership }) {
  if (!canManageGovernment(membership)) return { error: "Only a government manager or org owner/admin can author a policy knowledge base entry.", status: 403 };
  if (!key?.trim() || !title?.trim()) return { error: "A key and title are required.", status: 400 };

  const { policyKbEntries } = await getOrgCollections();
  const existingLatest = await policyKbEntries.find({ orgId: toObjectId(orgId), key: key.trim() }).sort({ version: -1 }).limit(1).toArray();
  if (existingLatest.length > 0) {
    return { error: `An entry with key "${key.trim()}" already exists (v${existingLatest[0].version}). Use amendEntry() to create a new version instead.`, status: 409 };
  }

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    key: key.trim(), version: 1, title: title.trim(), body: body || "",
    ownerEmail: ownerEmail || actorEmail, reviewCycleDays: reviewCycleDays || null,
    status: "DRAFT", immutable: false, effectiveDate: null, expiresAt: null, supersedes: null,
    approvedByEmail: null, approvedAt: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await policyKbEntries.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "POLICY_KB_ENTRY", recordId: inserted._id, actorEmail, action: "DRAFTED", previousState: null, newState: "DRAFT", metadata: { key: doc.key, version: 1 } });
  return { entry: inserted };
}

/** Only reachable while status is DRAFT or IN_REVIEW -- the atomic
 *  findOneAndUpdate's own status:{$in:[...]} filter is what makes this
 *  actually enforced, not just documented. */
export async function updateEntryDraft({ orgId, entryId, title, body, actorEmail, membership }) {
  if (!canManageGovernment(membership)) return { error: "Only a government manager or org owner/admin can edit a draft entry.", status: 403 };
  const { policyKbEntries } = await getOrgCollections();
  const setDoc = { updatedAt: new Date().toISOString() };
  if (title !== undefined) setDoc.title = title;
  if (body !== undefined) setDoc.body = body;

  const updated = await policyKbEntries.findOneAndUpdate(
    { _id: toObjectId(entryId), orgId: toObjectId(orgId), status: { $in: ["DRAFT", "IN_REVIEW"] } },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await policyKbEntries.findOne({ _id: toObjectId(entryId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Entry not found.", status: 404 };
    return { error: `This entry is ${current.status} and can no longer be edited directly — use amendEntry() to create a new version.`, status: 409 };
  }
  return { entry: updated };
}

export async function transitionEntry({ orgId, entryId, action, actorEmail, membership, note }) {
  if (!canManageGovernment(membership)) return { error: "Only a government manager or org owner/admin can update an entry.", status: 403 };
  const definition = POLICY_KB_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { policyKbEntries } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const entryObjectId = toObjectId(entryId);
  const now = new Date().toISOString();

  const setDoc = { status: definition.to, updatedAt: now };
  if (action === "approve") { setDoc.approvedByEmail = actorEmail; setDoc.approvedAt = now; }

  const updated = await policyKbEntries.findOneAndUpdate(
    { _id: entryObjectId, orgId: orgObjectId, status: definition.from },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await policyKbEntries.findOne({ _id: entryObjectId, orgId: orgObjectId });
    if (!current) return { error: "Entry not found.", status: 404 };
    return { error: `This entry isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "POLICY_KB_ENTRY", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  return { entry: updated };
}

/** The one and only path from APPROVED to live. From this point on, no
 *  function in this file can alter this document's title/body/status --
 *  only amendEntry() (below) can supersede it, by inserting a NEW row. */
export async function publishEntry({ orgId, entryId, effectiveDate, expiresAt, actorEmail, membership }) {
  if (!canManageGovernment(membership)) return { error: "Only a government manager or org owner/admin can publish an entry.", status: 403 };
  const { policyKbEntries } = await getOrgCollections();
  const now = new Date().toISOString();

  const updated = await policyKbEntries.findOneAndUpdate(
    { _id: toObjectId(entryId), orgId: toObjectId(orgId), status: "APPROVED" },
    { $set: { status: "PUBLISHED", immutable: true, effectiveDate: effectiveDate || now, expiresAt: expiresAt || null, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await policyKbEntries.findOne({ _id: toObjectId(entryId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Entry not found.", status: 404 };
    return { error: `Only an APPROVED entry can be published (this one is ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "POLICY_KB_ENTRY", recordId: updated._id, actorEmail, action: "PUBLISHED", previousState: "APPROVED", newState: "PUBLISHED", metadata: { effectiveDate: updated.effectiveDate } });
  return { entry: updated };
}

/** Creates a brand-new DRAFT document at version+1, linked via
 *  `supersedes`, and marks the currently-published row AMENDED (its
 *  content stays untouched and readable for historical/audit context --
 *  only its status field changes). The ONLY way to change published
 *  content. */
export async function amendEntry({ orgId, entryId, title, body, actorEmail, membership }) {
  if (!canManageGovernment(membership)) return { error: "Only a government manager or org owner/admin can amend an entry.", status: 403 };
  const { policyKbEntries } = await getOrgCollections();
  const current = await policyKbEntries.findOne({ _id: toObjectId(entryId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Entry not found.", status: 404 };
  if (current.status !== "PUBLISHED") return { error: `Only a PUBLISHED entry can be amended (this one is ${current.status}).`, status: 409 };

  const now = new Date().toISOString();
  const newDoc = {
    orgId: current.orgId, key: current.key, version: current.version + 1,
    title: title !== undefined ? title : current.title,
    body: body !== undefined ? body : current.body,
    ownerEmail: current.ownerEmail, reviewCycleDays: current.reviewCycleDays,
    status: "DRAFT", immutable: false, effectiveDate: null, expiresAt: null, supersedes: current._id,
    approvedByEmail: null, approvedAt: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await policyKbEntries.insertOne(newDoc);
  const inserted = { ...newDoc, _id: result.insertedId };

  await policyKbEntries.updateOne({ _id: current._id }, { $set: { status: "AMENDED", updatedAt: now } });

  await logOrgActivity({ orgId, recordType: "POLICY_KB_ENTRY", recordId: inserted._id, actorEmail, action: "AMENDMENT_DRAFTED", previousState: "PUBLISHED", newState: "DRAFT", metadata: { key: current.key, newVersion: inserted.version, supersedes: current._id } });
  return { entry: inserted };
}

export async function recordAcknowledgement({ orgId, entryId, memberEmail, actorEmail }) {
  const { policyKbAcknowledgements } = await getOrgCollections();
  const now = new Date().toISOString();
  await policyKbAcknowledgements.updateOne(
    { orgId: toObjectId(orgId), entryId: toObjectId(entryId), memberEmail },
    { $setOnInsert: { orgId: toObjectId(orgId), entryId: toObjectId(entryId), memberEmail, acknowledgedAt: now, recordedByEmail: actorEmail } },
    { upsert: true }
  );
  return { acknowledged: true };
}

export async function listEntries(orgId, { status, key, membership } = {}) {
  if (!canAccessGovernment(membership)) return { error: "You don't have Government OS access.", status: 403 };
  const { policyKbEntries } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (key) query.key = key;
  const entries = await policyKbEntries.find(query).sort({ key: 1, version: -1 }).toArray();
  return { entries };
}

export async function listExpiringEntries(orgId, { withinDays = 30 } = {}) {
  const { policyKbEntries } = await getOrgCollections();
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
  return policyKbEntries
    .find({ orgId: toObjectId(orgId), status: "PUBLISHED", expiresAt: { $ne: null, $lte: cutoff } })
    .sort({ expiresAt: 1 })
    .toArray();
}
