// src/lib/term-sheet.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§33) — Term
// Sheet Management. "private_capital" vertical only. "Track negotiation
// history" (§33) is enforced the same structural way investment-thesis.js
// enforces thesis-version history: content fields can only be edited
// while status is DRAFT; reviseTermSheet() is the only path forward once
// a term sheet has left DRAFT, and it always creates a NEW versioned
// document, never mutates the round being revised.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const TERM_SHEET_STATES = ["DRAFT", "SENT", "COUNTERED", "ACCEPTED", "REJECTED"];
export const TERM_SHEET_TRANSITIONS = {
  send: { from: "DRAFT", to: "SENT", activityAction: "SENT" },
  counter: { from: "SENT", to: "COUNTERED", activityAction: "COUNTERED" },
  accept: { from: ["SENT", "COUNTERED"], to: "ACCEPTED", activityAction: "ACCEPTED" },
  reject: { from: ["SENT", "COUNTERED"], to: "REJECTED", activityAction: "REJECTED" },
};

const CONTENT_FIELDS = [
  "valuation", "preMoney", "postMoney", "ownership", "optionPool", "liquidationPreference",
  "participation", "antiDilution", "boardRights", "votingRights", "informationRights",
  "proRata", "protectiveProvisions", "vesting", "founderTerms", "investorRights", "closingConditions",
];

export async function createTermSheet({ orgId, dealId, actorEmail, membership, ...content }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { termSheets } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), dealId: toObjectId(dealId), version: 1, supersedes: null, status: "DRAFT", createdByEmail: actorEmail, createdAt: now, updatedAt: now };
  for (const field of CONTENT_FIELDS) doc[field] = content[field] ?? null;

  const result = await termSheets.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "TERM_SHEET", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "DRAFT", metadata: { dealId } });
  return { termSheet: inserted };
}

/** Only reachable while status is DRAFT. */
export async function updateTermSheetDraft({ orgId, termSheetId, updates, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { termSheets } = await getOrgCollections();
  const setDoc = { updatedAt: new Date().toISOString() };
  for (const field of CONTENT_FIELDS) if (updates[field] !== undefined) setDoc[field] = updates[field];

  const updated = await termSheets.findOneAndUpdate(
    { _id: toObjectId(termSheetId), orgId: toObjectId(orgId), status: "DRAFT" },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await termSheets.findOne({ _id: toObjectId(termSheetId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Term sheet not found.", status: 404 };
    return { error: `This term sheet is ${current.status} and can no longer be edited directly -- use reviseTermSheet() to create a new negotiation round.`, status: 409 };
  }
  return { termSheet: updated };
}

export async function transitionTermSheet({ orgId, termSheetId, action, actorEmail, membership, note }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a term sheet.", status: 403 };
  const definition = TERM_SHEET_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { termSheets } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const termSheetObjectId = toObjectId(termSheetId);
  const now = new Date().toISOString();
  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;

  const updated = await termSheets.findOneAndUpdate(
    { _id: termSheetObjectId, orgId: orgObjectId, status: fromFilter },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await termSheets.findOne({ _id: termSheetObjectId, orgId: orgObjectId });
    if (!current) return { error: "Term sheet not found.", status: 404 };
    return { error: `This term sheet can't take action "${action}" from its current state (${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "TERM_SHEET", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: null, newState: definition.to, metadata: note ? { note } : {} });
  return { termSheet: updated };
}

/** The only way to change a term sheet's terms after it leaves DRAFT --
 *  a new negotiation round. Creates a NEW document at version+1; the
 *  prior round's content is never mutated. */
export async function reviseTermSheet({ orgId, termSheetId, updates, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { termSheets } = await getOrgCollections();
  const current = await termSheets.findOne({ _id: toObjectId(termSheetId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Term sheet not found.", status: 404 };
  if (current.status === "DRAFT") return { error: "A DRAFT term sheet can be edited directly with updateTermSheetDraft() -- no need to revise.", status: 409 };
  if (["ACCEPTED", "REJECTED"].includes(current.status)) return { error: `A ${current.status} term sheet is final and cannot be revised.`, status: 409 };

  const now = new Date().toISOString();
  const { _id, createdAt, updatedAt, version, supersedes, status, ...rest } = current;
  const newDoc = { ...rest, version: current.version + 1, supersedes: current._id, status: "DRAFT", createdAt: now, updatedAt: now, ...updates };
  const result = await termSheets.insertOne(newDoc);
  const inserted = { ...newDoc, _id: result.insertedId };

  await termSheets.updateOne({ _id: current._id }, { $set: { supersededBy: inserted._id, updatedAt: now } });
  await logOrgActivity({ orgId, recordType: "TERM_SHEET", recordId: inserted._id, actorEmail, action: "REVISION_DRAFTED", previousState: current.status, newState: "DRAFT", metadata: { dealId: current.dealId, newVersion: inserted.version, supersedes: current._id } });
  return { termSheet: inserted };
}

export async function listTermSheets(orgId, dealId) {
  const { termSheets } = await getOrgCollections();
  return termSheets.find({ orgId: toObjectId(orgId), dealId: toObjectId(dealId) }).sort({ version: -1 }).toArray();
}
