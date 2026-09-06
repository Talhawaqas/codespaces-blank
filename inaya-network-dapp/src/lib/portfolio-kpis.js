// src/lib/portfolio-kpis.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§38-39) —
// Portfolio KPI System + Portfolio Monitoring. "private_capital" vertical
// only.
//
// §38 explicitly says "do not hard-code one industry" -- a KPI definition
// is a user-created {key, label, unit}, not a fixed enum. ARR/MRR/burn/
// churn/etc. are examples in the SOW text, never a restriction list here.
//
// getPortfolioMonitoring() (§39) only aggregates what this system can
// actually compute from real data it holds: KPI trend (from
// portfolioKpiValues), upcoming board deadlines/action items (from
// board-management.js), and value-creation plan status (from
// value-creation.js). It deliberately does NOT fabricate "cyber
// incidents"/"regulatory issues"/"major contracts"/"management changes" --
// this codebase has no data source for those yet, and inventing empty
// placeholder sections would be worse than omitting them; a real
// deployment would wire those in from incidents.js/legal-* /vendor
// systems as that integration work is done.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function defineKpi({ orgId, portfolioCompanyId, key, label, unit, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can define a KPI.", status: 403 };
  if (!key?.trim() || !label?.trim()) return { error: "A KPI key and label are required.", status: 400 };

  const { portfolioKpiDefinitions } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId), key: key.trim(), label: label.trim(), unit: unit || null, createdByEmail: actorEmail, createdAt: now };
  try {
    const result = await portfolioKpiDefinitions.insertOne(doc);
    return { kpiDefinition: { ...doc, _id: result.insertedId } };
  } catch (err) {
    if (err?.code === 11000) return { error: `A KPI with key "${key.trim()}" already exists for this company.`, status: 409 };
    throw err;
  }
}

export async function recordKpiValue({ orgId, kpiDefinitionId, period, value, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!period?.trim()) return { error: "A period label is required.", status: 400 };
  if (typeof value !== "number") return { error: "value must be a number.", status: 400 };

  const { portfolioKpiValues } = await getOrgCollections();
  const now = new Date().toISOString();
  await portfolioKpiValues.updateOne(
    { orgId: toObjectId(orgId), kpiDefinitionId: toObjectId(kpiDefinitionId), period: period.trim() },
    { $set: { value, recordedByEmail: actorEmail, recordedAt: now } },
    { upsert: true }
  );
  await logOrgActivity({ orgId, recordType: "PORTFOLIO_KPI", recordId: toObjectId(kpiDefinitionId), actorEmail, action: "VALUE_RECORDED", previousState: null, newState: null, metadata: { period: period.trim(), value } });
  return { recorded: true };
}

export async function listKpiDefinitions(orgId, portfolioCompanyId) {
  const { portfolioKpiDefinitions } = await getOrgCollections();
  return portfolioKpiDefinitions.find({ orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId) }).sort({ createdAt: 1 }).toArray();
}

export async function listKpiValues(orgId, kpiDefinitionId) {
  const { portfolioKpiValues } = await getOrgCollections();
  return portfolioKpiValues.find({ orgId: toObjectId(orgId), kpiDefinitionId: toObjectId(kpiDefinitionId) }).sort({ period: 1 }).toArray();
}

/** Pulls together only what this system can actually compute -- see file
 *  header. Every section is explicitly labeled with its real source so a
 *  viewer knows what is and isn't covered, rather than presenting a
 *  seemingly-complete dashboard that silently omits categories. */
export async function getPortfolioMonitoring(orgId, portfolioCompanyId) {
  const { boardMeetings, valueCreationPlans } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const companyObjectId = toObjectId(portfolioCompanyId);

  const kpiDefs = await listKpiDefinitions(orgId, portfolioCompanyId);
  const kpiTrend = await Promise.all(kpiDefs.map(async (def) => ({
    key: def.key, label: def.label, unit: def.unit,
    values: await listKpiValues(orgId, def._id),
  })));

  const now = new Date().toISOString();
  const upcomingMeetings = await boardMeetings.find({ orgId: orgObjectId, portfolioCompanyId: companyObjectId, scheduledAt: { $gte: now } }).sort({ scheduledAt: 1 }).limit(5).toArray();
  const openActionItems = (await boardMeetings.find({ orgId: orgObjectId, portfolioCompanyId: companyObjectId }).toArray())
    .flatMap((m) => (m.actionItems || []).filter((a) => a.status === "open").map((a) => ({ ...a, meetingId: m._id })));

  const plans = await valueCreationPlans.find({ orgId: orgObjectId, portfolioCompanyId: companyObjectId }).toArray();
  const planStatusCounts = plans.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {});

  return {
    kpiTrend,
    upcomingBoardDeadlines: upcomingMeetings.map((m) => ({ meetingId: m._id, scheduledAt: m.scheduledAt, status: m.status })),
    openActionItems,
    valueCreationPlanStatus: planStatusCounts,
    // Explicitly not computed -- no data source wired in yet (see file header).
    notCovered: ["cyber_incidents", "regulatory_issues", "major_contracts", "management_changes", "cash_runway", "financing_needs", "covenant_status"],
  };
}
