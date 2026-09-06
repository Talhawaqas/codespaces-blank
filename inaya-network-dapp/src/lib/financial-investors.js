// src/lib/financial-investors.js
//
// Financial Services & Regulated Enterprise SOW, Phase 1 (§18) —
// Investor/LP Management. Capital activity (commitments, contributions,
// distributions) is its own sub-collection (financial_investor_
// commitments) rather than an array field on the investor doc — a fund
// can have many capital events over its life, and an array-of-events
// field would grow unbounded and be awkward to query/aggregate the way
// legal_time_entries/legal_trust_ledger already treat their own
// transaction histories as separate rows, not embedded arrays.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const INVESTOR_ENTITY_TYPES = ["individual", "trust", "corporation", "partnership", "pension_fund", "endowment", "sovereign_wealth_fund", "fund_of_funds", "family_office", "other"];
export const INVESTOR_ONBOARDING_STATUSES = ["prospective", "kyc_pending", "kyc_cleared", "subscribed", "active", "redeemed"];
export const CAPITAL_EVENT_TYPES = ["commitment", "contribution", "distribution"];

export async function createInvestor({ orgId, fundId, legalName, entityType, jurisdiction, accreditationStatus, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can add an investor.", status: 403 };
  if (!legalName?.trim()) return { error: "An investor legal name is required.", status: 400 };
  if (entityType && !INVESTOR_ENTITY_TYPES.includes(entityType)) return { error: `Unknown entity type "${entityType}".`, status: 400 };

  const { financialInvestors } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    fundId: fundId ? toObjectId(fundId) : null,
    legalName: legalName.trim(),
    entityType: entityType || "individual",
    jurisdiction: jurisdiction || null,
    onboardingStatus: "prospective",
    kycProviderStatus: "not_started",
    accreditationStatus: accreditationStatus || null,
    subscriptionDocuments: [],
    sideLetterObligations: [],
    reportingPermissions: { fundReports: true, portfolioExposure: false },
    communicationPreferences: { email: true },
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await financialInvestors.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "FINANCIAL_INVESTOR", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "prospective", metadata: { legalName: doc.legalName } });
  return { investor: inserted };
}

export async function updateInvestorOnboarding({ orgId, investorId, onboardingStatus, kycProviderStatus, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update investor onboarding.", status: 403 };
  if (onboardingStatus && !INVESTOR_ONBOARDING_STATUSES.includes(onboardingStatus)) return { error: `Unknown onboarding status "${onboardingStatus}".`, status: 400 };

  const { financialInvestors } = await getOrgCollections();
  const current = await financialInvestors.findOne({ _id: toObjectId(investorId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Investor not found.", status: 404 };

  const setDoc = { updatedAt: new Date().toISOString() };
  if (onboardingStatus) setDoc.onboardingStatus = onboardingStatus;
  if (kycProviderStatus) setDoc.kycProviderStatus = kycProviderStatus;

  const updated = await financialInvestors.findOneAndUpdate(
    { _id: toObjectId(investorId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "FINANCIAL_INVESTOR", recordId: updated._id, actorEmail, action: "ONBOARDING_UPDATED", previousState: current.onboardingStatus, newState: updated.onboardingStatus, metadata: {} });
  return { investor: updated };
}

/** Records one capital event (commitment/contribution/distribution) as
 *  its own immutable row — never edited or deleted, matching
 *  legal-billing-workflow.js's/trust-accounting.js's own append-only
 *  ledger discipline for financial transaction history. */
export async function recordCapitalEvent({ orgId, investorId, fundId, type, amount, currency, eventDate, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can record a capital event.", status: 403 };
  if (!CAPITAL_EVENT_TYPES.includes(type)) return { error: `Unknown capital event type "${type}".`, status: 400 };
  if (!amount || amount <= 0) return { error: "A positive amount is required.", status: 400 };

  const { financialInvestorCommitments } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    investorId: toObjectId(investorId),
    fundId: toObjectId(fundId),
    type, amount, currency: currency || "USD",
    eventDate: eventDate || now,
    recordedByEmail: actorEmail,
    createdAt: now,
  };
  const result = await financialInvestorCommitments.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "FINANCIAL_INVESTOR", recordId: toObjectId(investorId), actorEmail, action: `CAPITAL_${type.toUpperCase()}_RECORDED`, previousState: null, newState: null, metadata: { fundId: fundId?.toString?.() || fundId, amount, currency: doc.currency } });
  return { capitalEvent: inserted };
}

export async function getCapitalAccountSummary(orgId, investorId, fundId) {
  const { financialInvestorCommitments } = await getOrgCollections();
  const events = await financialInvestorCommitments.find({ orgId: toObjectId(orgId), investorId: toObjectId(investorId), fundId: toObjectId(fundId) }).sort({ eventDate: 1 }).toArray();
  const totals = { commitment: 0, contribution: 0, distribution: 0 };
  for (const e of events) totals[e.type] = (totals[e.type] || 0) + e.amount;
  return { events, totals, netAssetContributed: totals.contribution - totals.distribution };
}

export async function listInvestors(orgId, { fundId } = {}) {
  const { financialInvestors } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (fundId) query.fundId = toObjectId(fundId);
  return financialInvestors.find(query).sort({ legalName: 1 }).toArray();
}
