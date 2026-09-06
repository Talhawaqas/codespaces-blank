// src/lib/fund-registry.js
//
// Financial Services & Regulated Enterprise SOW, Phase 1 (§5) — the Fund
// registry, the central object of the Financial Entity Core. A fund's
// full field list per §5.1 (legal name, domicile, jurisdiction, base
// currency, administrator, custodian, prime broker, etc.) plus §5.2's
// hierarchy support (master/feeder, parallel funds, co-investment
// vehicles, SPVs, side pockets, managed/separate accounts) via
// `structureType` + `relatedFundIds`, rather than a separate collection
// per structure kind.
//
// Fund visibility is ASSIGNMENT-based (§5.3: "a user must not
// automatically inherit access across funds merely because they belong
// to the same organization") — financial_fund_team_assignments is the
// join table, mirroring health_care_team_assignments/
// legal_matter_team_assignments exactly. See document-permissions.js's
// getAccessibleScope() for where this plugs into the shared
// visibility resolver.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageFinancialEntities, isFundTeamMember } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const FUND_TYPES = ["hedge_fund", "long_short", "global_macro", "quantitative", "multi_strategy", "credit", "event_driven", "activist", "private_equity", "venture_capital", "private_credit", "fund_of_funds"];
export const FUND_STRUCTURE_TYPES = ["standalone", "master", "feeder", "parallel", "co_investment", "spv", "side_pocket", "managed_account", "separate_account"];
export const FUND_STATUSES = ["forming", "active", "closed", "wound_down"];

export async function createFund({ orgId, legalName, shortName, fundType, structureType, domicile, jurisdiction, baseCurrency, fiscalYearEnd, launchDate, strategy, administrator, auditor, legalCounsel, custodian, primeBroker, valuationProvider, managementCompanyEntityId, investmentAdviserEntityId, regulatoryClassification, reportingFrequency, relatedFundIds, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can register a fund.", status: 403 };
  if (!legalName?.trim()) return { error: "A fund legal name is required.", status: 400 };
  if (fundType && !FUND_TYPES.includes(fundType)) return { error: `Unknown fund type "${fundType}".`, status: 400 };
  if (structureType && !FUND_STRUCTURE_TYPES.includes(structureType)) return { error: `Unknown structure type "${structureType}".`, status: 400 };

  const { financialFunds, financialFundTeamAssignments } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    legalName: legalName.trim(),
    shortName: shortName || null,
    fundType: fundType || null,
    structureType: structureType || "standalone",
    domicile: domicile || null,
    jurisdiction: jurisdiction || null,
    baseCurrency: baseCurrency || "USD",
    fiscalYearEnd: fiscalYearEnd || null,
    launchDate: launchDate || null,
    status: "forming",
    strategy: strategy || null,
    administrator: administrator || null,
    auditor: auditor || null,
    legalCounsel: legalCounsel || null,
    custodian: custodian || null,
    primeBroker: primeBroker || null,
    valuationProvider: valuationProvider || null,
    managementCompanyEntityId: managementCompanyEntityId ? toObjectId(managementCompanyEntityId) : null,
    investmentAdviserEntityId: investmentAdviserEntityId ? toObjectId(investmentAdviserEntityId) : null,
    regulatoryClassification: regulatoryClassification || null,
    governingDocuments: [], offeringDocuments: [], subscriptionDocuments: [], sideLetters: [],
    reportingFrequency: reportingFrequency || "quarterly",
    relatedFundIds: (relatedFundIds || []).map((id) => toObjectId(id)),
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await financialFunds.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  // The fund's creator (the responsible partner in effect) is always
  // seeded onto the fund team — otherwise the person who just created
  // this fund couldn't see it themselves under the assignment-based
  // visibility model, matching legal-matter-workflow.js's own precedent
  // of auto-assigning the matter's creator.
  await financialFundTeamAssignments.insertOne({ orgId: toObjectId(orgId), fundId: inserted._id, email: actorEmail, role: "responsible_partner", assignedAt: now });

  await logOrgActivity({ orgId, recordType: "FINANCIAL_FUND", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "forming", metadata: { legalName: doc.legalName } });
  return { fund: inserted };
}

export async function updateFundStatus({ orgId, fundId, status, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a fund's status.", status: 403 };
  if (!FUND_STATUSES.includes(status)) return { error: `Unknown status "${status}".`, status: 400 };
  const { financialFunds } = await getOrgCollections();
  const current = await financialFunds.findOne({ _id: toObjectId(fundId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Fund not found.", status: 404 };

  const updated = await financialFunds.findOneAndUpdate(
    { _id: toObjectId(fundId), orgId: toObjectId(orgId) },
    { $set: { status, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "FINANCIAL_FUND", recordId: updated._id, actorEmail, action: "STATUS_CHANGED", previousState: current.status, newState: status, metadata: {} });
  return { fund: updated };
}

export async function assignFundTeamMember({ orgId, fundId, memberEmail, role, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can assign a fund team member.", status: 403 };
  if (!memberEmail?.trim()) return { error: "A member email is required.", status: 400 };

  const { financialFundTeamAssignments, financialFunds } = await getOrgCollections();
  const fund = await financialFunds.findOne({ _id: toObjectId(fundId), orgId: toObjectId(orgId) });
  if (!fund) return { error: "Fund not found.", status: 404 };

  const now = new Date().toISOString();
  await financialFundTeamAssignments.updateOne(
    { orgId: toObjectId(orgId), fundId: toObjectId(fundId), email: memberEmail.trim() },
    { $set: { role: role || "analyst", assignedAt: now } },
    { upsert: true }
  );
  await logOrgActivity({ orgId, recordType: "FINANCIAL_FUND", recordId: fund._id, actorEmail, action: "TEAM_MEMBER_ASSIGNED", previousState: null, newState: null, metadata: { memberEmail: memberEmail.trim(), role: role || "analyst" } });
  return { assigned: true };
}

export async function listFundTeam(orgId, fundId) {
  const { financialFundTeamAssignments } = await getOrgCollections();
  return financialFundTeamAssignments.find({ orgId: toObjectId(orgId), fundId: toObjectId(fundId) }).toArray();
}

export async function getFund(orgId, fundId) {
  const { financialFunds } = await getOrgCollections();
  return financialFunds.findOne({ _id: toObjectId(fundId), orgId: toObjectId(orgId) });
}

export { isFundTeamMember };
