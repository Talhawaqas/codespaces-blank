// src/lib/performance-analytics.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§24) —
// Performance & Attribution. "financial" vertical only. §24's own
// instruction: "No fabricated values" — every metric preserves its
// formula/source/timestamp/data version. Derived analytics (Sharpe,
// Sortino, alpha, beta) are only ever computed from inputs this module
// was actually given for that period; a period with insufficient inputs
// simply omits the derived metric rather than guessing, same discipline
// as compliance-health.js's "unknown, never fabricated" rule.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

/** Ingests one period's raw performance inputs and computes only the
 *  derived metrics that are actually computable from them. Every stored
 *  metric records its own formula string and dataVersion so a viewer can
 *  verify how it was produced, not just trust the number. */
export async function recordPerformancePeriod({ orgId, fundId, period, nav, grossReturn, netReturn, benchmarkReturn, contribution, drawdown, volatility, riskFreeRate, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can record performance.", status: 403 };
  if (!period?.trim()) return { error: "A period label (e.g. 2026-Q1) is required.", status: 400 };

  const now = new Date().toISOString();
  const derived = {};
  if (typeof netReturn === "number" && typeof volatility === "number" && volatility !== 0) {
    derived.sharpe = { value: (netReturn - (riskFreeRate || 0)) / volatility, formula: "(netReturn - riskFreeRate) / volatility", dataVersion: 1 };
  }
  if (typeof netReturn === "number" && typeof benchmarkReturn === "number") {
    derived.alpha = { value: netReturn - benchmarkReturn, formula: "netReturn - benchmarkReturn", dataVersion: 1 };
  }

  const { performanceMetrics } = await getOrgCollections();
  const doc = {
    orgId: toObjectId(orgId), fundId: toObjectId(fundId), period: period.trim(),
    inputs: { nav: nav ?? null, grossReturn: grossReturn ?? null, netReturn: netReturn ?? null, benchmarkReturn: benchmarkReturn ?? null, contribution: contribution ?? null, drawdown: drawdown ?? null, volatility: volatility ?? null, riskFreeRate: riskFreeRate ?? null },
    derived,
    recordedByEmail: actorEmail, recordedAt: now,
  };
  await performanceMetrics.updateOne(
    { orgId: toObjectId(orgId), fundId: toObjectId(fundId), period: period.trim() },
    { $set: doc },
    { upsert: true }
  );

  await logOrgActivity({ orgId, recordType: "FINANCIAL_FUND", recordId: toObjectId(fundId), actorEmail, action: "PERFORMANCE_RECORDED", previousState: null, newState: null, metadata: { period: doc.period } });
  return { performance: doc };
}

export async function listPerformance(orgId, fundId) {
  const { performanceMetrics } = await getOrgCollections();
  return performanceMetrics.find({ orgId: toObjectId(orgId), fundId: toObjectId(fundId) }).sort({ period: 1 }).toArray();
}
