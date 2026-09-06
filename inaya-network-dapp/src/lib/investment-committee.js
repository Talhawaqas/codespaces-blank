// src/lib/investment-committee.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§8) — the
// Investment Committee workspace. "financial" vertical only.
//
// Two separate objects, matching the plan's explicit decision NOT to
// conflate them: `investment_committee_cases` is the working case (can
// move through review states, can be withdrawn/deferred) and
// `ic_decisions` is an append-only, versioned record of each FINALIZED
// decision (§8.4: "decision record cannot be silently modified;
// amendments create a new version; original decision remains
// preserved") — same versioned-snapshot pattern compliance-policies.js
// and investment-thesis.js already established for exactly this kind
// of "never silently overwritten" requirement.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const IC_CASE_STATES = [
  "DRAFT", "SUBMITTED", "UNDER_RESEARCH", "COMPLIANCE_REVIEW", "RISK_REVIEW", "IC_SCHEDULED",
  "APPROVED", "APPROVED_WITH_CONDITIONS", "REJECTED", "DEFERRED", "WITHDRAWN", "EXECUTED", "MONITORING", "CLOSED",
];

// `from` may be a single state or an array of allowed source states —
// `withdraw` is legal from most pre-decision states, everything else
// follows a strict single-predecessor chain.
export const IC_CASE_TRANSITIONS = {
  submit: { from: "DRAFT", to: "SUBMITTED", activityAction: "SUBMITTED" },
  startResearch: { from: "SUBMITTED", to: "UNDER_RESEARCH", activityAction: "RESEARCH_STARTED" },
  submitForComplianceReview: { from: "UNDER_RESEARCH", to: "COMPLIANCE_REVIEW", activityAction: "COMPLIANCE_REVIEW_STARTED" },
  submitForRiskReview: { from: "COMPLIANCE_REVIEW", to: "RISK_REVIEW", activityAction: "RISK_REVIEW_STARTED" },
  scheduleIC: { from: "RISK_REVIEW", to: "IC_SCHEDULED", activityAction: "IC_SCHEDULED" },
  resumeFromDeferral: { from: "DEFERRED", to: "IC_SCHEDULED", activityAction: "RESUMED" },
  execute: { from: ["APPROVED", "APPROVED_WITH_CONDITIONS"], to: "EXECUTED", activityAction: "EXECUTED" },
  beginMonitoring: { from: "EXECUTED", to: "MONITORING", activityAction: "MONITORING_STARTED" },
  close: { from: "MONITORING", to: "CLOSED", activityAction: "CLOSED" },
  withdraw: { from: ["DRAFT", "SUBMITTED", "UNDER_RESEARCH", "COMPLIANCE_REVIEW", "RISK_REVIEW", "IC_SCHEDULED"], to: "WITHDRAWN", activityAction: "WITHDRAWN" },
};

// The four possible outcomes of an actual IC vote — each finalizes the
// case AND creates an immutable ic_decisions record in one atomic step.
const DECISION_OUTCOMES = { approve: "APPROVED", approveWithConditions: "APPROVED_WITH_CONDITIONS", reject: "REJECTED", defer: "DEFERRED" };

export async function createCase({ orgId, fundId, opportunity, thesisId, proposedPosition, proposedAllocation, committeeMembers, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!opportunity?.trim()) return { error: "An opportunity description is required.", status: 400 };

  const { investmentCommitteeCases } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    fundId: fundId ? toObjectId(fundId) : null,
    opportunity: opportunity.trim(),
    thesisId: thesisId ? toObjectId(thesisId) : null,
    proposedPosition: proposedPosition || null,
    proposedAllocation: proposedAllocation || null,
    committeeMembers: committeeMembers || [],
    conflicts: [],
    status: "DRAFT",
    meetingNotes: [],
    latestDecisionId: null,
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await investmentCommitteeCases.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "IC_CASE", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "DRAFT", metadata: { opportunity: doc.opportunity } });
  return { case: inserted };
}

export async function transitionCase({ orgId, caseId, action, actorEmail, membership, note }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update an IC case.", status: 403 };
  const definition = IC_CASE_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { investmentCommitteeCases } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const caseObjectId = toObjectId(caseId);
  const now = new Date().toISOString();
  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;

  const updated = await investmentCommitteeCases.findOneAndUpdate(
    { _id: caseObjectId, orgId: orgObjectId, status: fromFilter },
    { $set: { status: definition.to, updatedAt: now }, $push: { meetingNotes: note ? { note, actorEmail, at: now } : undefined } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await investmentCommitteeCases.findOne({ _id: caseObjectId, orgId: orgObjectId });
    if (!current) return { error: "Case not found.", status: 404 };
    return { error: `This case can't take action "${action}" from its current state (${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "IC_CASE", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: null, newState: definition.to, metadata: note ? { note } : {} });
  return { case: updated };
}

/** The actual IC vote. Only reachable from IC_SCHEDULED. Creates an
 *  IMMUTABLE ic_decisions snapshot (version 1 for this case) AND
 *  transitions the case in one call — a decision and its case-state
 *  change are the same event, never recorded separately where they
 *  could drift out of sync. */
export async function recordDecision({ orgId, caseId, outcome, conditions, dissentingViews, finalResolution, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can record an IC decision.", status: 403 };
  const newStatus = DECISION_OUTCOMES[outcome];
  if (!newStatus) return { error: `Unknown decision outcome "${outcome}".`, status: 400 };

  const { investmentCommitteeCases, icDecisions } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const caseObjectId = toObjectId(caseId);
  const now = new Date().toISOString();

  const updatedCase = await investmentCommitteeCases.findOneAndUpdate(
    { _id: caseObjectId, orgId: orgObjectId, status: "IC_SCHEDULED" },
    { $set: { status: newStatus, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updatedCase) {
    const current = await investmentCommitteeCases.findOne({ _id: caseObjectId, orgId: orgObjectId });
    if (!current) return { error: "Case not found.", status: 404 };
    return { error: `A decision can only be recorded from IC_SCHEDULED (this case is ${current.status}).`, status: 409 };
  }

  const decisionDoc = {
    orgId: orgObjectId, caseId: caseObjectId, version: 1, supersedes: null,
    outcome: newStatus, conditions: conditions || null, dissentingViews: dissentingViews || [],
    finalResolution: finalResolution || null,
    committeeMembers: updatedCase.committeeMembers, supportingDocumentIds: [],
    decidedByEmail: actorEmail, decidedAt: now,
  };
  const result = await icDecisions.insertOne(decisionDoc);
  const decision = { ...decisionDoc, _id: result.insertedId };

  await investmentCommitteeCases.updateOne({ _id: caseObjectId }, { $set: { latestDecisionId: decision._id } });
  await logOrgActivity({ orgId, recordType: "IC_CASE", recordId: caseObjectId, actorEmail, action: "DECISION_RECORDED", previousState: "IC_SCHEDULED", newState: newStatus, metadata: { decisionId: decision._id } });
  await createNotification({
    scope: "org", orgId, targetEmail: null, category: "approval", severity: "info",
    type: "ic_decision_recorded", title: `IC decision recorded: ${updatedCase.opportunity} — ${newStatus.replace(/_/g, " ")}`, body: finalResolution || "",
    sourceModule: "investment-committee", sourceId: caseObjectId, actionUrl: "/business?view=financial",
    dedupeKey: `${orgId}:ic_decision_recorded:${decision._id}`,
  });

  return { case: updatedCase, decision };
}

/** Amends a finalized decision — creates a NEW ic_decisions row at
 *  version+1, linked via `supersedes`. The original decision row is
 *  never mutated; only reachable once a decision already exists for
 *  this case. Does not change the case's own status. */
export async function amendDecision({ orgId, caseId, conditions, dissentingViews, finalResolution, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can amend an IC decision.", status: 403 };
  const { investmentCommitteeCases, icDecisions } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const caseObjectId = toObjectId(caseId);

  const orgCase = await investmentCommitteeCases.findOne({ _id: caseObjectId, orgId: orgObjectId });
  if (!orgCase || !orgCase.latestDecisionId) return { error: "No existing decision to amend for this case.", status: 404 };
  const current = await icDecisions.findOne({ _id: orgCase.latestDecisionId, orgId: orgObjectId });
  if (!current) return { error: "Decision record not found.", status: 404 };

  const now = new Date().toISOString();
  const newDoc = {
    orgId: orgObjectId, caseId: caseObjectId, version: current.version + 1, supersedes: current._id,
    outcome: current.outcome,
    conditions: conditions !== undefined ? conditions : current.conditions,
    dissentingViews: dissentingViews !== undefined ? dissentingViews : current.dissentingViews,
    finalResolution: finalResolution !== undefined ? finalResolution : current.finalResolution,
    committeeMembers: current.committeeMembers, supportingDocumentIds: current.supportingDocumentIds,
    decidedByEmail: actorEmail, decidedAt: now,
  };
  const result = await icDecisions.insertOne(newDoc);
  const inserted = { ...newDoc, _id: result.insertedId };

  await investmentCommitteeCases.updateOne({ _id: caseObjectId }, { $set: { latestDecisionId: inserted._id, updatedAt: now } });
  await logOrgActivity({ orgId, recordType: "IC_CASE", recordId: caseObjectId, actorEmail, action: "DECISION_AMENDED", previousState: null, newState: null, metadata: { newDecisionId: inserted._id, supersedes: current._id } });
  return { decision: inserted };
}

export async function listCases(orgId, { status, fundId } = {}) {
  const { investmentCommitteeCases } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (fundId) query.fundId = toObjectId(fundId);
  return investmentCommitteeCases.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getCaseDecisionHistory(orgId, caseId) {
  const { icDecisions } = await getOrgCollections();
  return icDecisions.find({ orgId: toObjectId(orgId), caseId: toObjectId(caseId) }).sort({ version: -1 }).toArray();
}
