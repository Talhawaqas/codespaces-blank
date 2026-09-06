// src/lib/financial-counterparties.js
//
// Financial Services & Regulated Enterprise SOW, Phase 1 (§13, §65) —
// Counterparty Management with an onboarding workflow. Deliberately a
// separate module from vendor-management.js (Trust & Compliance Center,
// Phase 4): a counterparty carries financial-specific fields (exposure,
// collateral limits, agreements) a generic IT/security vendor record
// doesn't need, and conflating the two would force one schema to serve
// two different concepts. The onboarding STATE MACHINE below is new —
// vendor-management.js never got one (documented as a known gap in the
// Phase 4 summary) — so this is the first real precedent for it in this
// app, following incidents.js's TRANSITIONS-map pattern exactly.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const COUNTERPARTY_TYPES = ["prime_broker", "bank", "custodian", "otc_counterparty", "clearing_broker", "administrator", "technology_vendor", "data_vendor", "legal_provider"];

export const ONBOARDING_STATES = ["REQUESTED", "QUESTIONNAIRE", "RISK_ASSESSMENT", "LEGAL_REVIEW", "APPROVED", "CONTRACTED", "MONITORING", "REJECTED"];

export const ONBOARDING_TRANSITIONS = {
  sendQuestionnaire: { from: "REQUESTED", to: "QUESTIONNAIRE", activityAction: "QUESTIONNAIRE_SENT" },
  submitForRiskAssessment: { from: "QUESTIONNAIRE", to: "RISK_ASSESSMENT", activityAction: "RISK_ASSESSMENT_STARTED" },
  submitForLegalReview: { from: "RISK_ASSESSMENT", to: "LEGAL_REVIEW", activityAction: "LEGAL_REVIEW_STARTED" },
  approve: { from: "LEGAL_REVIEW", to: "APPROVED", activityAction: "APPROVED" },
  reject: { from: "LEGAL_REVIEW", to: "REJECTED", activityAction: "REJECTED" },
  contract: { from: "APPROVED", to: "CONTRACTED", activityAction: "CONTRACTED" },
  beginMonitoring: { from: "CONTRACTED", to: "MONITORING", activityAction: "MONITORING_STARTED" },
};

export async function createCounterparty({ orgId, type, name, riskRating, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can add a counterparty.", status: 403 };
  if (!COUNTERPARTY_TYPES.includes(type)) return { error: `Unknown counterparty type "${type}".`, status: 400 };
  if (!name?.trim()) return { error: "A counterparty name is required.", status: 400 };

  const { financialCounterparties } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    type, name: name.trim(),
    onboardingStatus: "REQUESTED",
    riskRating: riskRating || "unrated",
    exposure: null, agreements: [], limits: {}, collateral: {},
    renewalDate: null, concentration: null,
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await financialCounterparties.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "FINANCIAL_COUNTERPARTY", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "REQUESTED", metadata: { type, name: doc.name } });
  return { counterparty: inserted };
}

export async function transitionCounterpartyOnboarding({ orgId, counterpartyId, action, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update counterparty onboarding.", status: 403 };
  const definition = ONBOARDING_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { financialCounterparties } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const cpObjectId = toObjectId(counterpartyId);
  const now = new Date().toISOString();

  const updated = await financialCounterparties.findOneAndUpdate(
    { _id: cpObjectId, orgId: orgObjectId, onboardingStatus: definition.from },
    { $set: { onboardingStatus: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await financialCounterparties.findOne({ _id: cpObjectId, orgId: orgObjectId });
    if (!current) return { error: "Counterparty not found.", status: 404 };
    return { error: `This counterparty isn't in ${definition.from} state (it's currently ${current.onboardingStatus}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "FINANCIAL_COUNTERPARTY", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: {} });
  return { counterparty: updated };
}

export async function updateCounterpartyExposure({ orgId, counterpartyId, exposure, limits, collateral, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update counterparty exposure.", status: 403 };
  const { financialCounterparties } = await getOrgCollections();
  const setDoc = { updatedAt: new Date().toISOString() };
  if (exposure !== undefined) setDoc.exposure = exposure;
  if (limits !== undefined) setDoc.limits = limits;
  if (collateral !== undefined) setDoc.collateral = collateral;

  const updated = await financialCounterparties.findOneAndUpdate(
    { _id: toObjectId(counterpartyId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Counterparty not found.", status: 404 };
  return { counterparty: updated };
}

export async function listCounterparties(orgId, { type, onboardingStatus } = {}) {
  const { financialCounterparties } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (type) query.type = type;
  if (onboardingStatus) query.onboardingStatus = onboardingStatus;
  return financialCounterparties.find(query).sort({ name: 1 }).toArray();
}
