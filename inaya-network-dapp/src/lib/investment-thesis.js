// src/lib/investment-thesis.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§7) —
// Investment Thesis lifecycle: DRAFT -> REVIEW -> IC_REVIEW -> APPROVED
// -> ACTIVE -> MONITORING -> CLOSED. "financial" vertical only.
//
// "No historical thesis version may be silently overwritten" (§7) is
// enforced the same structural way compliance-policies.js enforces
// policy immutability: content fields (assumptions, valuation, upside/
// downside, etc.) can only be edited while status is DRAFT.
// reviseThesis() is the only path forward once a thesis has left DRAFT —
// it always creates a NEW versioned document, never mutates the one
// being revised.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const THESIS_STATES = ["DRAFT", "REVIEW", "IC_REVIEW", "APPROVED", "ACTIVE", "MONITORING", "CLOSED"];

export const THESIS_TRANSITIONS = {
  submitForReview: { from: "DRAFT", to: "REVIEW", activityAction: "SUBMITTED_FOR_REVIEW" },
  submitToIC: { from: "REVIEW", to: "IC_REVIEW", activityAction: "SUBMITTED_TO_IC" },
  returnToDraft: { from: "REVIEW", to: "DRAFT", activityAction: "RETURNED_TO_DRAFT" },
  approve: { from: "IC_REVIEW", to: "APPROVED", activityAction: "APPROVED" },
  reject: { from: "IC_REVIEW", to: "DRAFT", activityAction: "REJECTED" },
  activate: { from: "APPROVED", to: "ACTIVE", activityAction: "ACTIVATED" },
  beginMonitoring: { from: "ACTIVE", to: "MONITORING", activityAction: "MONITORING_STARTED" },
  close: { from: "MONITORING", to: "CLOSED", activityAction: "CLOSED" },
};

export async function createThesis({ orgId, key, title, target, strategy, catalyst, horizon, valuation, assumptions, upside, downside, probability, keyRisks, invalidationCriteria, monitoringIndicators, competitiveLandscape, supportingResearchIds, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!key?.trim() || !title?.trim()) return { error: "A thesis key and title are required.", status: 400 };

  const { investmentTheses } = await getOrgCollections();
  const existingLatest = await investmentTheses.find({ orgId: toObjectId(orgId), key: key.trim() }).sort({ version: -1 }).limit(1).toArray();
  if (existingLatest.length > 0) {
    return { error: `A thesis with key "${key.trim()}" already exists (v${existingLatest[0].version}). Use reviseThesis() to create a new version instead.`, status: 409 };
  }

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), key: key.trim(), version: 1, supersedes: null,
    title: title.trim(), target: target || null, strategy: strategy || null,
    author: actorEmail, date: now, catalyst: catalyst || null, horizon: horizon || null,
    valuation: valuation || null, assumptions: assumptions || null, upside: upside || null, downside: downside || null,
    probability: probability || null, keyRisks: keyRisks || null, invalidationCriteria: invalidationCriteria || null,
    monitoringIndicators: monitoringIndicators || null, competitiveLandscape: competitiveLandscape || null,
    supportingResearchIds: (supportingResearchIds || []).map((id) => toObjectId(id)),
    icDecisionId: null,
    status: "DRAFT",
    createdAt: now, updatedAt: now,
  };
  const result = await investmentTheses.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "INVESTMENT_THESIS", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "DRAFT", metadata: { key: doc.key, title: doc.title } });
  return { thesis: inserted };
}

/** Only reachable while status is DRAFT — matches compliance-policies.js's
 *  updatePolicyDraft() precedent exactly. */
export async function updateThesisDraft({ orgId, thesisId, updates, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { investmentTheses } = await getOrgCollections();
  const allowed = ["title", "target", "strategy", "catalyst", "horizon", "valuation", "assumptions", "upside", "downside", "probability", "keyRisks", "invalidationCriteria", "monitoringIndicators", "competitiveLandscape"];
  const setDoc = { updatedAt: new Date().toISOString() };
  for (const key of allowed) if (updates[key] !== undefined) setDoc[key] = updates[key];

  const updated = await investmentTheses.findOneAndUpdate(
    { _id: toObjectId(thesisId), orgId: toObjectId(orgId), status: "DRAFT" },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await investmentTheses.findOne({ _id: toObjectId(thesisId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Thesis not found.", status: 404 };
    return { error: `This thesis is ${current.status} and can no longer be edited directly — use reviseThesis() to create a new version.`, status: 409 };
  }
  return { thesis: updated };
}

export async function transitionThesis({ orgId, thesisId, action, actorEmail, membership, note }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a thesis.", status: 403 };
  const definition = THESIS_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { investmentTheses } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const thesisObjectId = toObjectId(thesisId);
  const now = new Date().toISOString();

  const updated = await investmentTheses.findOneAndUpdate(
    { _id: thesisObjectId, orgId: orgObjectId, status: definition.from },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await investmentTheses.findOne({ _id: thesisObjectId, orgId: orgObjectId });
    if (!current) return { error: "Thesis not found.", status: 404 };
    return { error: `This thesis isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "INVESTMENT_THESIS", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  return { thesis: updated };
}

/** The only way to change a thesis's content after it leaves DRAFT —
 *  creates a NEW document at version+1, marks the current one
 *  superseded via a `supersededBy` pointer. The prior version's content
 *  is never mutated. */
export async function reviseThesis({ orgId, thesisId, updates, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { investmentTheses } = await getOrgCollections();
  const current = await investmentTheses.findOne({ _id: toObjectId(thesisId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Thesis not found.", status: 404 };
  if (current.status === "DRAFT") return { error: "A DRAFT thesis can be edited directly with updateThesisDraft() — no need to revise.", status: 409 };

  const now = new Date().toISOString();
  const { _id, createdAt, updatedAt, version, supersedes, status, icDecisionId, ...rest } = current;
  const newDoc = {
    ...rest,
    version: current.version + 1,
    supersedes: current._id,
    status: "DRAFT",
    icDecisionId: null,
    author: actorEmail,
    date: now,
    createdAt: now, updatedAt: now,
    ...updates,
  };
  const result = await investmentTheses.insertOne(newDoc);
  const inserted = { ...newDoc, _id: result.insertedId };

  await investmentTheses.updateOne({ _id: current._id }, { $set: { supersededBy: inserted._id, updatedAt: now } });

  await logOrgActivity({ orgId, recordType: "INVESTMENT_THESIS", recordId: inserted._id, actorEmail, action: "REVISION_DRAFTED", previousState: current.status, newState: "DRAFT", metadata: { key: current.key, newVersion: inserted.version, supersedes: current._id } });
  return { thesis: inserted };
}

export async function listTheses(orgId, { status, key } = {}) {
  const { investmentTheses } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (key) query.key = key;
  return investmentTheses.find(query).sort({ key: 1, version: -1 }).toArray();
}
