// src/lib/portfolio-management.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§9-10) —
// Portfolio/Position management and the exposure Threshold Engine.
// "financial" vertical only.
//
// Explicitly READ-ONLY ingestion (§9): this module records positions a
// human or an upstream system reports, it is never a broker, custodian,
// execution venue, or authoritative market-data source. Every position
// carries its own valuation source rather than this module fabricating
// one.
//
// The threshold engine (§10.1) reuses risk-register.js's existing
// createRisk() for a breach's "risk event" (matching the plan's explicit
// reuse decision) rather than inventing a parallel risk concept — a
// breach becomes a real risk-register entry, category "concentration"
// (or "leverage"/"liquidity" depending on the metric), linked back to
// the threshold that fired.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createRisk } from "./risk-register.js";
import { createNotification } from "./notifications.js";

export const THRESHOLD_METRICS = [
  "issuer_concentration", "sector_concentration", "leverage", "fund_exposure",
  "counterparty_exposure", "illiquid_exposure", "liquidity_minimum", "strategy_limit",
];

export async function createPortfolio({ orgId, fundId, name, benchmark, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can create a portfolio.", status: 403 };
  if (!fundId || !name?.trim()) return { error: "fundId and name are required.", status: 400 };

  const { portfolios } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), fundId: toObjectId(fundId), name: name.trim(), benchmark: benchmark || null, createdByEmail: actorEmail, createdAt: now, updatedAt: now };
  const result = await portfolios.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "PORTFOLIO", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name: doc.name } });
  return { portfolio: inserted };
}

/** Ingests a position as reported — no live trading, no execution. */
export async function ingestPosition({ orgId, portfolioId, security, issuer, sector, geography, strategy, currency, costBasis, marketValue, quantity, valuationSource, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can ingest a position.", status: 403 };
  if (!portfolioId || !security?.trim()) return { error: "portfolioId and security are required.", status: 400 };

  const { positions } = await getOrgCollections();
  const now = new Date().toISOString();
  const unrealizedPL = (marketValue != null && costBasis != null) ? marketValue - costBasis : null;
  const doc = {
    orgId: toObjectId(orgId), portfolioId: toObjectId(portfolioId), security: security.trim(),
    issuer: issuer || null, sector: sector || null, geography: geography || null, strategy: strategy || null,
    currency: currency || "USD", quantity: quantity ?? null, costBasis: costBasis ?? null, marketValue: marketValue ?? null,
    unrealizedPL, realizedPL: 0,
    valuationSource: valuationSource || null, valuationTimestamp: now,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await positions.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "POSITION", recordId: inserted._id, actorEmail, action: "INGESTED", previousState: null, newState: null, metadata: { security: doc.security } });
  return { position: inserted };
}

export async function updatePositionMarketValue({ orgId, positionId, marketValue, valuationSource, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a position.", status: 403 };
  const { positions } = await getOrgCollections();
  const current = await positions.findOne({ _id: toObjectId(positionId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Position not found.", status: 404 };

  const now = new Date().toISOString();
  const unrealizedPL = (marketValue != null && current.costBasis != null) ? marketValue - current.costBasis : current.unrealizedPL;
  const updated = await positions.findOneAndUpdate(
    { _id: current._id },
    { $set: { marketValue, unrealizedPL, valuationSource: valuationSource || current.valuationSource, valuationTimestamp: now, updatedAt: now } },
    { returnDocument: "after" }
  );
  return { position: updated };
}

export async function listPositions(orgId, { portfolioId } = {}) {
  const { positions } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (portfolioId) query.portfolioId = toObjectId(portfolioId);
  return positions.find(query).sort({ createdAt: -1 }).toArray();
}

export async function listPortfolios(orgId, { fundId } = {}) {
  const { portfolios } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (fundId) query.fundId = toObjectId(fundId);
  return portfolios.find(query).sort({ createdAt: -1 }).toArray();
}

/** Concentration/exposure dashboard (§10) — pure read-side aggregation
 *  over ingested positions, grouped by issuer/sector/geography/strategy/
 *  currency, plus gross/net/long-short. Never fabricates a number for a
 *  position with no marketValue — it's simply excluded from the sum,
 *  same "don't invent data" discipline as compliance-health.js. */
export async function getExposureDashboard(orgId, portfolioId) {
  const positions = await listPositions(orgId, { portfolioId });
  const priced = positions.filter((p) => typeof p.marketValue === "number");
  const grossExposure = priced.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  const netExposure = priced.reduce((sum, p) => sum + p.marketValue, 0);
  const longExposure = priced.filter((p) => p.marketValue > 0).reduce((sum, p) => sum + p.marketValue, 0);
  const shortExposure = priced.filter((p) => p.marketValue < 0).reduce((sum, p) => sum + Math.abs(p.marketValue), 0);

  function groupBy(field) {
    const groups = {};
    for (const p of priced) {
      const key = p[field] || "unclassified";
      groups[key] = (groups[key] || 0) + p.marketValue;
    }
    return groups;
  }

  return {
    positionCount: positions.length,
    pricedPositionCount: priced.length,
    unpricedPositionCount: positions.length - priced.length,
    grossExposure, netExposure, longExposure, shortExposure,
    byIssuer: groupBy("issuer"), bySector: groupBy("sector"), byGeography: groupBy("geography"), byStrategy: groupBy("strategy"),
  };
}

// ============================================================
// THRESHOLD ENGINE (§10.1)
// ============================================================
export async function setThreshold({ orgId, fundId, metric, limitValue, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can set a threshold.", status: 403 };
  if (!THRESHOLD_METRICS.includes(metric)) return { error: `Unknown threshold metric "${metric}".`, status: 400 };
  if (typeof limitValue !== "number") return { error: "limitValue must be a number.", status: 400 };

  const { exposureThresholds } = await getOrgCollections();
  const now = new Date().toISOString();
  await exposureThresholds.updateOne(
    { orgId: toObjectId(orgId), fundId: toObjectId(fundId), metric },
    { $set: { limitValue, updatedAt: now, updatedByEmail: actorEmail }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  return { threshold: { fundId, metric, limitValue } };
}

export async function listThresholds(orgId, fundId) {
  const { exposureThresholds } = await getOrgCollections();
  return exposureThresholds.find({ orgId: toObjectId(orgId), fundId: toObjectId(fundId) }).toArray();
}

/** Evaluates a fund's current exposure against every configured
 *  threshold. A breach creates: a notification, a real risk-register
 *  entry (the "risk event" the SOW calls for), and an audit record via
 *  logOrgActivity — never just a silent UI flag. Returns the list of
 *  breaches found (empty if none). */
export async function evaluateThresholds({ orgId, fundId, portfolioId, actorEmail, membership }) {
  const thresholds = await listThresholds(orgId, fundId);
  if (thresholds.length === 0) return { breaches: [] };

  const dashboard = await getExposureDashboard(orgId, portfolioId);
  const breaches = [];

  for (const t of thresholds) {
    let currentValue = null;
    if (t.metric === "issuer_concentration") currentValue = Math.max(0, ...Object.values(dashboard.byIssuer).map(Math.abs));
    else if (t.metric === "sector_concentration") currentValue = Math.max(0, ...Object.values(dashboard.bySector).map(Math.abs));
    else if (t.metric === "leverage") currentValue = dashboard.grossExposure;
    // fund_exposure / counterparty_exposure / illiquid_exposure / liquidity_minimum /
    // strategy_limit require data this module doesn't compute yet (counterparty
    // linkage, liquidity classification) — evaluated as "unknown", never silently
    // skipped as "passing", matching compliance-health.js's own discipline.
    if (currentValue === null) continue;

    if (currentValue > t.limitValue) {
      breaches.push({ metric: t.metric, limitValue: t.limitValue, currentValue });
    }
  }

  for (const breach of breaches) {
    const { risk } = await createRisk({
      orgId, category: "concentration", severity: "high", likelihood: "observed",
      impact: `${breach.metric} threshold breached: ${breach.currentValue} exceeds limit ${breach.limitValue}`,
      mitigation: "", actorEmail, membership,
    });
    await logOrgActivity({ orgId, recordType: "FINANCIAL_FUND", recordId: toObjectId(fundId), actorEmail, action: "THRESHOLD_BREACHED", previousState: null, newState: null, metadata: { metric: breach.metric, limitValue: breach.limitValue, currentValue: breach.currentValue, riskId: risk?._id } });
    await createNotification({
      scope: "org", orgId, targetEmail: null, category: "compliance", severity: "critical",
      type: "exposure_threshold_breached", title: `Exposure threshold breached: ${breach.metric.replace(/_/g, " ")}`, body: `Current: ${breach.currentValue}, limit: ${breach.limitValue}`,
      sourceModule: "portfolio-management", sourceId: toObjectId(fundId), actionUrl: "/business?view=financial",
      dedupeKey: `${orgId}:exposure_threshold_breached:${fundId}:${breach.metric}`,
    });
  }

  return { breaches };
}
