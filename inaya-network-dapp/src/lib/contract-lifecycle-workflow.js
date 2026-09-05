// src/lib/contract-lifecycle-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 8 (§11.26) — contract lifecycle.
// Templated directly on document-workflow.js's TRANSITIONS-map pattern.
// Negotiation versions are stored as a plain array of version snapshots
// on the contract record itself (not separate documents) since a
// negotiation version here is metadata about the negotiation, not a
// full document revision — the actual document content stays in
// org_documents via `documentId`, versioned there if needed.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters, canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const CONTRACT_STATES = ["INTAKE", "DRAFT", "REVIEW", "APPROVED", "NEGOTIATION", "SIGNED", "EXPIRED"];

export const CONTRACT_TRANSITIONS = {
  startDrafting: { from: "INTAKE", to: "DRAFT", activityAction: "DRAFTING_STARTED" },
  submitForReview: { from: "DRAFT", to: "REVIEW", activityAction: "SUBMITTED_FOR_REVIEW" },
  approve: { from: "REVIEW", to: "APPROVED", activityAction: "APPROVED" },
  sendForNegotiation: { from: "APPROVED", to: "NEGOTIATION", activityAction: "NEGOTIATION_STARTED" },
  sign: { from: ["APPROVED", "NEGOTIATION"], to: "SIGNED", activityAction: "SIGNED" },
};

export async function createContract({ orgId, matterId, name, counterparty, templateKey, documentId, obligations, expirationDate, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to create a contract.", status: 403 };
  const { legalContracts } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: matterId ? toObjectId(matterId) : null, name, counterparty: counterparty || null,
    templateKey: templateKey || null, documentId: documentId ? toObjectId(documentId) : null,
    obligations: obligations || [], expirationDate: expirationDate || null, negotiationVersions: [],
    status: "INTAKE", createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalContracts.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "CONTRACT", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "INTAKE", metadata: { name } });
  return { contract: inserted };
}

export async function transitionContract({ orgId, contractId, action, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to update this contract.", status: 403 };
  const definition = CONTRACT_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { legalContracts } = await getOrgCollections();
  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const current = await legalContracts.findOne({ _id: toObjectId(contractId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Contract not found.", status: 404 };

  const updated = await legalContracts.findOneAndUpdate(
    { _id: toObjectId(contractId), orgId: toObjectId(orgId), status: fromFilter },
    { $set: { status: definition.to, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This contract isn't in ${expected} state (it's currently ${current.status}).`, status: 409 };
  }
  await logOrgActivity({ orgId, recordType: "CONTRACT", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: current.status, newState: definition.to, metadata: {} });
  return { contract: updated };
}

export async function addNegotiationVersion({ orgId, contractId, summary, documentId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to add a negotiation version.", status: 403 };
  const { legalContracts } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await legalContracts.findOneAndUpdate(
    { _id: toObjectId(contractId), orgId: toObjectId(orgId), status: "NEGOTIATION" },
    { $push: { negotiationVersions: { summary, documentId: documentId ? toObjectId(documentId) : null, actorEmail, at: now } }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Contract must be in NEGOTIATION state to add a version.", status: 409 };
  return { contract: updated };
}

/** Renewal alerting — cron-driven, same pattern as invoice-workflow.js's
 *  markOverdueInvoices and health-scheduling.js's reminders. */
export async function sendExpirationAlerts(daysAhead = 30) {
  const { legalContracts } = await getOrgCollections();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const expiring = await legalContracts.find({ status: "SIGNED", expirationDate: { $gte: now.toISOString(), $lte: windowEnd }, expirationAlertSentAt: { $exists: false } }).toArray();

  let sent = 0;
  for (const contract of expiring) {
    const updated = await legalContracts.findOneAndUpdate(
      { _id: contract._id, expirationAlertSentAt: { $exists: false } },
      { $set: { expirationAlertSentAt: new Date().toISOString() } }
    );
    if (!updated) continue;
    await createNotification({
      scope: "org", orgId: contract.orgId, targetEmail: null, category: "business", severity: "warning",
      type: "contract_expiring", title: `Contract expiring: ${contract.name}`, body: `Expires ${contract.expirationDate}`,
      sourceModule: "contract-lifecycle-workflow", sourceId: contract._id, actionUrl: "/business?view=legal",
      dedupeKey: `${contract.orgId}:contract_expiring:${contract._id}`,
    });
    sent += 1;
  }
  return { checked: expiring.length, sent };
}
