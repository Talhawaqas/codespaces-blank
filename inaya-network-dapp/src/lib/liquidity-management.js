// src/lib/liquidity-management.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§12) —
// Liquidity Management. "financial" vertical only. A liquidity scenario
// is a point-in-time modeling run, not a live/authoritative forecast —
// every scenario records its own assumptions and a data timestamp
// (§12: "all scenario outputs must identify assumptions and data
// timestamps"), same non-fabrication discipline as valuation-
// management.js and performance-analytics.js.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const SCENARIO_TYPES = ["normal", "stressed", "severe", "custom"];

export async function recordLiquidityProfile({ orgId, fundId, redemptionProfile, lockups, gates, sidePockets, expectedCashNeeds, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can record a liquidity profile.", status: 403 };
  const { financialFunds } = await getOrgCollections();
  const fund = await financialFunds.findOne({ _id: toObjectId(fundId), orgId: toObjectId(orgId) });
  if (!fund) return { error: "Fund not found.", status: 404 };

  const now = new Date().toISOString();
  await financialFunds.updateOne(
    { _id: fund._id },
    { $set: { liquidityProfile: { redemptionProfile: redemptionProfile || null, lockups: lockups || null, gates: gates || null, sidePockets: sidePockets || null, expectedCashNeeds: expectedCashNeeds || null, updatedAt: now, updatedByEmail: actorEmail } } }
  );
  await logOrgActivity({ orgId, recordType: "FINANCIAL_FUND", recordId: fund._id, actorEmail, action: "LIQUIDITY_PROFILE_UPDATED", previousState: null, newState: null, metadata: {} });
  return { updated: true };
}

/** Runs a scenario against a set of liquidity buckets the caller
 *  supplies (each {classification, marketValue, daysToLiquidate}) —
 *  this module does not itself classify positions as liquid/illiquid,
 *  it models whatever bucket breakdown it's given. Every run is stored
 *  as its own immutable record, never overwritten. */
export async function runLiquidityScenario({ orgId, fundId, scenarioType, buckets, assumptions, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!SCENARIO_TYPES.includes(scenarioType)) return { error: `Unknown scenario type "${scenarioType}".`, status: 400 };
  if (!Array.isArray(buckets) || buckets.length === 0) return { error: "At least one liquidity bucket is required.", status: 400 };

  const now = new Date().toISOString();
  const totalValue = buckets.reduce((sum, b) => sum + (b.marketValue || 0), 0);
  const within7Days = buckets.filter((b) => (b.daysToLiquidate || 0) <= 7).reduce((sum, b) => sum + (b.marketValue || 0), 0);
  const within30Days = buckets.filter((b) => (b.daysToLiquidate || 0) <= 30).reduce((sum, b) => sum + (b.marketValue || 0), 0);

  const { liquidityScenarios } = await getOrgCollections();
  const doc = {
    orgId: toObjectId(orgId), fundId: toObjectId(fundId), scenarioType,
    buckets, assumptions: assumptions || null,
    totalValue, liquidWithin7Days: within7Days, liquidWithin30Days: within30Days,
    dataTimestamp: now,
    runByEmail: actorEmail, createdAt: now,
  };
  const result = await liquidityScenarios.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "FINANCIAL_FUND", recordId: toObjectId(fundId), actorEmail, action: "LIQUIDITY_SCENARIO_RUN", previousState: null, newState: null, metadata: { scenarioType, totalValue } });
  return { scenario: inserted };
}

export async function listLiquidityScenarios(orgId, fundId) {
  const { liquidityScenarios } = await getOrgCollections();
  return liquidityScenarios.find({ orgId: toObjectId(orgId), fundId: toObjectId(fundId) }).sort({ createdAt: -1 }).toArray();
}

export async function getFundLiquidityProfile(orgId, fundId) {
  const { financialFunds } = await getOrgCollections();
  const fund = await financialFunds.findOne({ _id: toObjectId(fundId), orgId: toObjectId(orgId) });
  return fund?.liquidityProfile || null;
}
