// src/lib/executive-compliance-dashboard.js
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§113) —
// Executive Compliance Dashboard. Distinct from compliance-health.js
// (Phase 4's Continuous Compliance dashboard, which is control/evidence/
// finding-scoped only): this is the executive-level view §113 asks for,
// widening that same honest overallStatus discipline across vendor risk,
// audit readiness, and resilience/policy status too -- a pure
// aggregation over already-existing modules, never a new data model.

import { getComplianceHealth } from "./compliance-health.js";
import { listVendors } from "./vendor-management.js";
import { listAuditPlans } from "./internal-audit.js";
import { getOperationalResilienceDashboard } from "./operational-resilience.js";
import { listPolicies, listExpiringPolicies } from "./compliance-policies.js";

export async function getExecutiveComplianceDashboard(orgId) {
  const [complianceHealth, vendors, auditPlans, resilience, publishedPolicies, expiringPolicies] = await Promise.all([
    getComplianceHealth(orgId),
    listVendors(orgId),
    listAuditPlans(orgId),
    getOperationalResilienceDashboard(orgId),
    listPolicies(orgId, { status: "PUBLISHED" }),
    listExpiringPolicies(orgId, { withinDays: 30 }),
  ]);

  const criticalVendorsAtRisk = vendors.filter((v) => v.criticality === "critical" && v.onboardingStatus !== "MONITORING").length;
  const openAuditPlans = auditPlans.filter((p) => p.status !== "CLOSED").length;
  const auditReadiness = auditPlans.length === 0 ? "unknown" : openAuditPlans === 0 ? "ready" : "in_progress";

  return {
    computedAt: new Date().toISOString(),
    compliancePosture: { overallStatus: complianceHealth.overallStatus, controlsPassing: complianceHealth.controlsPassing, controlsFailing: complianceHealth.controlsFailing, controlsUnknown: complianceHealth.controlsUnknown },
    controlHealth: { totalControls: complianceHealth.totalControls, overdueReviews: complianceHealth.overdueReviews },
    openFindings: complianceHealth.openFindings,
    criticalFindings: complianceHealth.criticalFindings,
    vendorRisk: { totalVendors: vendors.length, criticalVendorsAtRisk },
    evidenceReadiness: { expiringSoon: complianceHealth.evidenceExpiringSoon },
    auditReadiness: { status: auditReadiness, totalPlans: auditPlans.length, openPlans: openAuditPlans },
    resilience: { runbooksNeedingAttention: resilience.runbooksNeedingAttention.length, openIncidentCount: resilience.openIncidentCount },
    policyStatus: { published: publishedPolicies.length, expiringSoon: expiringPolicies.length },
    remediationProgress: complianceHealth.remediationProgress,
  };
}
