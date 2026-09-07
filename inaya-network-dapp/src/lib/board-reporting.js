// src/lib/board-reporting.js
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§115) — Board
// Reporting. "AI may draft; authorized human approves" maps directly onto
// this codebase's existing draft/publish discipline (same shape as
// compliance-policies.js's DRAFT -> PUBLISHED, immutable once published):
// draftBoardReport() compiles real structured data from every domain
// already built this SOW into one DRAFT document; nothing is visible as
// an official board report until publishBoardReport() -- a real human
// action -- approves it. No LLM call here: the "draft" is the real
// aggregated numbers, not a generated narrative a reviewer would have to
// fact-check against the actual data anyway.
//
// Sections not applicable to an org's vertical are marked
// notApplicable:true with a reason, never silently omitted or filled with
// a fabricated number -- a Regulated Enterprise org has no "investment
// exposure" or "portfolio performance", and pretending otherwise would be
// exactly the kind of fabrication this SOW repeatedly forbids.
// "Regulatory changes" has no live external feed in this codebase (same
// honesty boundary ai-regulatory-tools.js already draws) -- this section
// reports the org's enabled-framework/policy state instead of inventing a
// change feed.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { getOrgProfile } from "./industry-config.js";
import { logOrgActivity } from "./org-activity-log.js";
import { appendAuditEntry } from "./auditChain.js";
import { getExecutiveRiskDashboard } from "./executive-risk-dashboard.js";
import { getExecutiveComplianceDashboard } from "./executive-compliance-dashboard.js";
import { getOperationalResilienceDashboard } from "./operational-resilience.js";
import { listIncidents } from "./incidents.js";
import { getOrgEnabledFrameworks, listFrameworks } from "./compliance-frameworks.js";
import { listExpiringPolicies } from "./compliance-policies.js";

export const BOARD_REPORT_STATUSES = ["DRAFT", "PUBLISHED"];

async function buildInvestmentExposureSection(orgId, vertical) {
  if (vertical !== "financial") return { notApplicable: true, reason: "Investment exposure applies only to the Financial Services vertical." };
  const { positions, exposureThresholds } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const [positionCount, thresholdCount] = await Promise.all([
    positions.countDocuments({ orgId: orgObjectId }),
    exposureThresholds.countDocuments({ orgId: orgObjectId }),
  ]);
  return { positionCount, configuredThresholdCount: thresholdCount };
}

async function buildPortfolioPerformanceSection(orgId, vertical) {
  if (vertical !== "financial" && vertical !== "private_capital") {
    return { notApplicable: true, reason: "Portfolio performance applies only to the Financial Services and Private Capital verticals." };
  }
  const { performanceMetrics, portfolioCompanies } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const [metricCount, portfolioCompanyCount] = await Promise.all([
    performanceMetrics.countDocuments({ orgId: orgObjectId }),
    portfolioCompanies.countDocuments({ orgId: orgObjectId }),
  ]);
  return { recordedMetricCount: metricCount, portfolioCompanyCount };
}

async function buildRegulatoryChangesSection(orgId) {
  const [enabledFrameworkIds, expiringPolicies] = await Promise.all([
    getOrgEnabledFrameworks(orgId),
    listExpiringPolicies(orgId, { withinDays: 90 }),
  ]);
  return {
    note: "No live external regulatory-change feed exists in this codebase — this reflects the org's own configured framework/policy state, not incoming regulatory change events.",
    enabledFrameworks: enabledFrameworkIds.map((id) => listFrameworks().find((f) => f.id === id)?.name || id),
    policiesExpiringWithin90Days: expiringPolicies.length,
  };
}

/** Compiles every section from real, already-computed data. Stores it as
 *  a DRAFT -- not yet an official board report until a human publishes
 *  it. */
export async function draftBoardReport({ orgId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can draft a board report.", status: 403 };

  const profile = await getOrgProfile(orgId).catch(() => null);
  const vertical = profile?.vertical || "general";

  const [riskDashboard, complianceDashboard, resilience, incidents, investmentExposure, portfolioPerformance, regulatoryChanges] = await Promise.all([
    getExecutiveRiskDashboard(orgId),
    getExecutiveComplianceDashboard(orgId),
    getOperationalResilienceDashboard(orgId),
    listIncidents(orgId, {}),
    buildInvestmentExposureSection(orgId, vertical),
    buildPortfolioPerformanceSection(orgId, vertical),
    buildRegulatoryChangesSection(orgId),
  ]);

  const sections = {
    riskOverview: riskDashboard,
    cybersecurity: { openIncidentCount: resilience.openIncidentCount, criticalAssetCount: resilience.criticalAssetCount },
    compliance: complianceDashboard,
    incidents: { total: incidents.length, open: incidents.filter((i) => i.status === "OPEN").length },
    operationalResilience: resilience,
    investmentExposure,
    portfolioPerformance,
    regulatoryChanges,
    remediationProgress: complianceDashboard.remediationProgress,
  };

  const { boardReports } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), status: "DRAFT", vertical, sections, draftedByEmail: actorEmail, draftedAt: now, publishedByEmail: null, publishedAt: null };
  const result = await boardReports.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "BOARD_REPORT", recordId: inserted._id, actorEmail, action: "DRAFTED", previousState: null, newState: "DRAFT", metadata: {} });
  return { report: inserted };
}

/** The ONLY path to an official board report. Once published, no function
 *  in this file can alter the report's sections -- a later report is a
 *  new document, exactly like compliance-policies.js's immutability. */
export async function publishBoardReport({ orgId, reportId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can publish a board report.", status: 403 };
  const { boardReports } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await boardReports.findOneAndUpdate(
    { _id: toObjectId(reportId), orgId: toObjectId(orgId), status: "DRAFT" },
    { $set: { status: "PUBLISHED", publishedByEmail: actorEmail, publishedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await boardReports.findOne({ _id: toObjectId(reportId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Board report not found.", status: 404 };
    return { error: `Only a DRAFT report can be published (this one is ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "BOARD_REPORT", recordId: updated._id, actorEmail, action: "PUBLISHED", previousState: "DRAFT", newState: "PUBLISHED", metadata: {} });
  try { await appendAuditEntry({ orgId, recordType: "BOARD_REPORT", recordId: updated._id, action: "PUBLISHED", actorEmail, metadata: {} }); } catch (err) { console.error("appendAuditEntry failed (non-fatal):", err.message); }

  return { report: updated };
}

export async function listBoardReports(orgId, { status } = {}) {
  const { boardReports } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return boardReports.find(query).sort({ draftedAt: -1 }).toArray();
}

export async function getBoardReport(orgId, reportId) {
  const { boardReports } = await getOrgCollections();
  return boardReports.findOne({ _id: toObjectId(reportId), orgId: toObjectId(orgId) });
}
