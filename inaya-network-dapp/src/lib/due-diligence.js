// src/lib/due-diligence.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§31) — Due
// Diligence Management. "private_capital" vertical only. A structured
// diligence workspace: one diligence_requests row per (deal, domain,
// request) triple, walking a small state machine (same {STATES,
// TRANSITIONS, atomic findOneAndUpdate} shape used everywhere else in
// this codebase) from OPEN through to CLOSED, with risk/conclusion only
// ever set at REVIEWED, never guessed earlier. Evidence is append-only
// (org_documents pointers, same indirection investment-research.js and
// clinical/legal records already use) — a reviewer's conclusion can
// reference what was actually submitted, never silently replace it.

import { getOrgCollections, canAccessFinancialEntities, canManageFinancialEntities, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const DILIGENCE_DOMAINS = [
  "commercial", "financial", "legal", "tax", "technology", "cybersecurity", "product",
  "market", "regulatory", "hr", "ip", "insurance", "esg", "data_protection", "vendor_risk", "operations",
];

export const DILIGENCE_STATES = ["OPEN", "IN_PROGRESS", "SUBMITTED", "REVIEWED", "CLOSED"];
export const DILIGENCE_TRANSITIONS = {
  start: { from: "OPEN", to: "IN_PROGRESS", activityAction: "STARTED" },
  submit: { from: "IN_PROGRESS", to: "SUBMITTED", activityAction: "SUBMITTED" },
  close: { from: "REVIEWED", to: "CLOSED", activityAction: "CLOSED" },
};

export async function createDiligenceRequest({ orgId, dealId, domain, request, ownerEmail, dueDate, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!DILIGENCE_DOMAINS.includes(domain)) return { error: `Unknown diligence domain "${domain}".`, status: 400 };
  if (!request?.trim()) return { error: "A request description is required.", status: 400 };

  const { diligenceRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), dealId: toObjectId(dealId), domain, request: request.trim(),
    ownerEmail: ownerEmail || actorEmail, source: null, dueDate: dueDate || null,
    evidence: [], reviewerEmail: null, risk: null, conclusion: null,
    status: "OPEN",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await diligenceRequests.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "DILIGENCE_REQUEST", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "OPEN", metadata: { domain, request: doc.request } });
  return { request: inserted };
}

/** Append-only — never replaces a prior submission, matching
 *  investment-research.js's addAnnotation() precedent. */
export async function submitEvidence({ orgId, requestId, documentId, note, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { diligenceRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const entry = { documentId: documentId ? toObjectId(documentId) : null, note: note || null, submittedByEmail: actorEmail, submittedAt: now };

  const updated = await diligenceRequests.findOneAndUpdate(
    { _id: toObjectId(requestId), orgId: toObjectId(orgId) },
    { $push: { evidence: entry }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Diligence request not found.", status: 404 };
  return { request: updated };
}

export async function transitionRequest({ orgId, requestId, action, actorEmail, membership, note }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a diligence request.", status: 403 };
  const definition = DILIGENCE_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { diligenceRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);
  const now = new Date().toISOString();

  const updated = await diligenceRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: definition.from },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await diligenceRequests.findOne({ _id: requestObjectId, orgId: orgObjectId });
    if (!current) return { error: "Diligence request not found.", status: 404 };
    return { error: `This request isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "DILIGENCE_REQUEST", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  return { request: updated };
}

/** Only reachable from SUBMITTED -- risk/conclusion are set exactly once,
 *  at review time, never guessed at creation. */
export async function reviewRequest({ orgId, requestId, risk, conclusion, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can review a diligence request.", status: 403 };
  if (!conclusion?.trim()) return { error: "A conclusion is required to review a request.", status: 400 };

  const { diligenceRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);
  const now = new Date().toISOString();

  const updated = await diligenceRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: "SUBMITTED" },
    { $set: { status: "REVIEWED", reviewerEmail: actorEmail, risk: risk || null, conclusion: conclusion.trim(), updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await diligenceRequests.findOne({ _id: requestObjectId, orgId: orgObjectId });
    if (!current) return { error: "Diligence request not found.", status: 404 };
    return { error: `A request can only be reviewed from SUBMITTED (this one is ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "DILIGENCE_REQUEST", recordId: updated._id, actorEmail, action: "REVIEWED", previousState: "SUBMITTED", newState: "REVIEWED", metadata: { risk } });
  return { request: updated };
}

export async function listDiligenceRequests(orgId, { dealId, domain, status } = {}) {
  const { diligenceRequests } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (dealId) query.dealId = toObjectId(dealId);
  if (domain) query.domain = domain;
  if (status) query.status = status;
  return diligenceRequests.find(query).sort({ createdAt: -1 }).toArray();
}
