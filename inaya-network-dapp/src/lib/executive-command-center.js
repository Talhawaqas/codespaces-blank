// src/lib/executive-command-center.js
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§188's
// "executive command center" bullet, scoped conservatively) — a single
// read-only aggregator combining Trust Health 2.0, the Executive Risk
// Dashboard, the Executive Compliance Dashboard, and the latest board
// report's status into one call. This is deliberately NOT a rewrite of
// the existing OS Home screen (a live, shipped surface) -- it is the data
// layer a future vertical-specific OS Home (§188's Financial Services OS
// Home / Regulated Enterprise OS Home) would consume. Wiring it into the
// OS Home UI itself is an explicit fast-follow, not silently dropped:
// see the Phase 8 commit message.

import { computeTrustHealth2 } from "./trust-health-v2.js";
import { getExecutiveRiskDashboard } from "./executive-risk-dashboard.js";
import { getExecutiveComplianceDashboard } from "./executive-compliance-dashboard.js";
import { listBoardReports } from "./board-reporting.js";
import { listAiActionRequests } from "./ai-action-requests.js";

export async function getExecutiveCommandCenter(orgId) {
  const [trustHealth, riskDashboard, complianceDashboard, recentReports, pendingApprovals] = await Promise.all([
    computeTrustHealth2(orgId),
    getExecutiveRiskDashboard(orgId),
    getExecutiveComplianceDashboard(orgId),
    listBoardReports(orgId, {}),
    listAiActionRequests({ orgId, status: "PENDING_APPROVAL" }),
  ]);

  const latestPublished = recentReports.find((r) => r.status === "PUBLISHED") || null;
  const latestDraft = recentReports.find((r) => r.status === "DRAFT") || null;

  return {
    computedAt: new Date().toISOString(),
    trustHealth,
    riskDashboard,
    complianceDashboard,
    boardReporting: {
      latestPublishedReportId: latestPublished ? latestPublished._id.toString() : null,
      latestPublishedAt: latestPublished ? latestPublished.publishedAt : null,
      hasUnpublishedDraft: !!latestDraft,
    },
    pendingApprovalCount: pendingApprovals.length,
  };
}
