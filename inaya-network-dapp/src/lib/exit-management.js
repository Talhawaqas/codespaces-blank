// src/lib/exit-management.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§41) — Exit
// Management. "private_capital" vertical only.
//
// "IC approvals" (§41) reuses investment-committee.js's existing case/
// decision engine rather than a second approval concept: the normal flow
// is a user creates an IC case for the exit opportunity through the
// existing Investment Committee workflow, and once a decision is
// recorded there, approveExit() here just verifies that decision's
// outcome and links it -- it does not orchestrate IC case creation
// itself. Post-exit distribution is recorded here only as a summary
// figure; full per-investor waterfall allocation is out of scope for
// this pass and would extend financial-investors.js's capital-event
// ledger (recordCapitalEvent, type "distribution") rather than being
// reinvented here.

import { getOrgCollections, canAccessFinancialEntities, canManageFinancialEntities, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const EXIT_STATES = ["READINESS", "BUYER_OUTREACH", "DILIGENCE", "BIDS_RECEIVED", "NEGOTIATION", "IC_APPROVED", "CLOSING", "CLOSED"];
export const EXIT_TRANSITIONS = {
  beginOutreach: { from: "READINESS", to: "BUYER_OUTREACH", activityAction: "OUTREACH_STARTED" },
  beginDiligence: { from: "BUYER_OUTREACH", to: "DILIGENCE", activityAction: "DILIGENCE_STARTED" },
  receiveBids: { from: "DILIGENCE", to: "BIDS_RECEIVED", activityAction: "BIDS_RECEIVED" },
  negotiate: { from: "BIDS_RECEIVED", to: "NEGOTIATION", activityAction: "NEGOTIATION_STARTED" },
  close: { from: "CLOSING", to: "CLOSED", activityAction: "CLOSED" },
};

export async function createExit({ orgId, portfolioCompanyId, exitType, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can start an exit process.", status: 403 };
  const { exits } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId), exitType: exitType || null,
    bids: [], icDecisionId: null, distributionAmount: null,
    status: "READINESS",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await exits.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "EXIT", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "READINESS", metadata: { portfolioCompanyId } });
  return { exit: inserted };
}

export async function transitionExit({ orgId, exitId, action, actorEmail, membership, note }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update an exit.", status: 403 };
  const definition = EXIT_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { exits } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const exitObjectId = toObjectId(exitId);
  const now = new Date().toISOString();

  const updated = await exits.findOneAndUpdate(
    { _id: exitObjectId, orgId: orgObjectId, status: definition.from },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await exits.findOne({ _id: exitObjectId, orgId: orgObjectId });
    if (!current) return { error: "Exit not found.", status: 404 };
    return { error: `This exit isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "EXIT", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  return { exit: updated };
}

export async function recordBid({ orgId, exitId, buyerName, buyerType, amount, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!["strategic", "financial"].includes(buyerType)) return { error: `Unknown buyer type "${buyerType}".`, status: 400 };
  if (!buyerName?.trim() || typeof amount !== "number") return { error: "buyerName and a numeric amount are required.", status: 400 };

  const { exits } = await getOrgCollections();
  const now = new Date().toISOString();
  const bid = { buyerName: buyerName.trim(), buyerType, amount, recordedByEmail: actorEmail, submittedAt: now };

  const updated = await exits.findOneAndUpdate(
    { _id: toObjectId(exitId), orgId: toObjectId(orgId) },
    { $push: { bids: bid }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Exit not found.", status: 404 };
  return { exit: updated };
}

/** Only reachable from NEGOTIATION. Verifies the linked IC decision is a
 *  real approval outcome rather than trusting a client-supplied flag. */
export async function approveExit({ orgId, exitId, icDecisionId, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can approve an exit.", status: 403 };
  const { exits, icDecisions } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const exitObjectId = toObjectId(exitId);

  const decision = await icDecisions.findOne({ _id: toObjectId(icDecisionId), orgId: orgObjectId });
  if (!decision) return { error: "IC decision not found.", status: 404 };
  if (!["APPROVED", "APPROVED_WITH_CONDITIONS"].includes(decision.outcome)) return { error: `The linked IC decision's outcome (${decision.outcome}) is not an approval.`, status: 409 };

  const now = new Date().toISOString();
  const updated = await exits.findOneAndUpdate(
    { _id: exitObjectId, orgId: orgObjectId, status: "NEGOTIATION" },
    { $set: { status: "IC_APPROVED", icDecisionId: decision._id, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await exits.findOne({ _id: exitObjectId, orgId: orgObjectId });
    if (!current) return { error: "Exit not found.", status: 404 };
    return { error: `Approval is only valid from NEGOTIATION (this exit is ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "EXIT", recordId: exitObjectId, actorEmail, action: "IC_APPROVED", previousState: "NEGOTIATION", newState: "IC_APPROVED", metadata: { icDecisionId: decision._id } });
  return { exit: updated };
}

/** Only reachable once IC_APPROVED -- moves to CLOSING before the final
 *  "close" transition, mirroring the IC case's own EXECUTED/MONITORING
 *  distinction between "approved" and "actually done". */
export async function beginClosing({ orgId, exitId, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can begin closing.", status: 403 };
  const { exits } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await exits.findOneAndUpdate(
    { _id: toObjectId(exitId), orgId: toObjectId(orgId), status: "IC_APPROVED" },
    { $set: { status: "CLOSING", updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Closing can only begin from IC_APPROVED.", status: 409 };
  await logOrgActivity({ orgId, recordType: "EXIT", recordId: updated._id, actorEmail, action: "CLOSING_STARTED", previousState: "IC_APPROVED", newState: "CLOSING", metadata: {} });
  return { exit: updated };
}

export async function recordDistribution({ orgId, exitId, distributionAmount, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can record a distribution.", status: 403 };
  if (typeof distributionAmount !== "number") return { error: "distributionAmount must be a number.", status: 400 };
  const { exits } = await getOrgCollections();
  const updated = await exits.findOneAndUpdate(
    { _id: toObjectId(exitId), orgId: toObjectId(orgId) },
    { $set: { distributionAmount, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Exit not found.", status: 404 };
  return { exit: updated };
}

export async function listExits(orgId, { portfolioCompanyId, status } = {}) {
  const { exits } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (portfolioCompanyId) query.portfolioCompanyId = toObjectId(portfolioCompanyId);
  if (status) query.status = status;
  return exits.find(query).sort({ createdAt: -1 }).toArray();
}
