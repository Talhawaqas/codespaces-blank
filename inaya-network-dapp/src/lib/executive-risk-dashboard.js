// src/lib/executive-risk-dashboard.js
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§114) —
// Executive Risk Dashboard. A pure read-aggregation over risk-register.js,
// incidents.js, operational-resilience.js, and (when the org runs the
// financial vertical) exposure-thresholds — never a parallel risk store.
//
// Risk category bucketing is honest about its own limits: risk-register.js
// stores `category` as a free-form string (no enforced enum), so a risk
// only lands in "financial"/"operational"/"cyber"/"regulatory" when its
// stored category string actually matches (case-insensitively) -- anything
// else goes to "other" rather than being silently dropped or guessed into
// the wrong bucket.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { listRisks } from "./risk-register.js";
import { listIncidents } from "./incidents.js";
import { getOperationalResilienceDashboard } from "./operational-resilience.js";

const CATEGORY_BUCKETS = { financial: "financial", operational: "operational", cyber: "cyber", security: "cyber", regulatory: "regulatory", compliance: "regulatory" };

function bucketRisk(risk) {
  return CATEGORY_BUCKETS[(risk.category || "").toLowerCase()] || "other";
}

export async function getExecutiveRiskDashboard(orgId) {
  const [openRisks, majorIncidents, resilience, configuredThresholdCount] = await Promise.all([
    listRisks(orgId, { status: "open" }),
    listIncidents(orgId, { status: "OPEN" }),
    getOperationalResilienceDashboard(orgId),
    (async () => {
      const { exposureThresholds } = await getOrgCollections();
      return exposureThresholds.countDocuments({ orgId: toObjectId(orgId) });
    })(),
  ]);

  const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  const sorted = [...openRisks].sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  const topRisks = { financial: [], operational: [], cyber: [], regulatory: [], other: [] };
  for (const risk of sorted) {
    const bucket = bucketRisk(risk);
    topRisks[bucket].push({ id: risk._id.toString(), category: risk.category, severity: risk.severity, mitigation: risk.mitigation || null, reviewDate: risk.reviewDate });
  }
  for (const bucket of Object.keys(topRisks)) topRisks[bucket] = topRisks[bucket].slice(0, 5);

  const now = new Date().toISOString();
  const overdueActions = openRisks.filter((r) => r.reviewDate && r.reviewDate < now).length;

  return {
    computedAt: now,
    topRisks,
    totalOpenRisks: openRisks.length,
    overdueActions,
    majorIncidentCount: majorIncidents.length,
    majorIncidents: majorIncidents.slice(0, 5).map((i) => ({ id: i._id.toString(), category: i.category, severity: i.severity, status: i.status })),
    // A breach is evaluated on demand (portfolio-management.js's
    // evaluateThresholds) and creates a real "concentration" risk-register
    // entry -- it is not a persisted field on the threshold document
    // itself, so this dashboard cannot honestly report a live breach
    // count here. configuredThresholdCount is what the schema actually
    // supports reporting; open concentration risks (bucketed under
    // "financial" above) are the real breach signal.
    configuredThresholdCount,
    resilienceStatus: {
      runbooksNeedingAttention: resilience.runbooksNeedingAttention.length,
      openIncidentCount: resilience.openIncidentCount,
      uncoveredTestTypes: resilience.uncoveredTestTypes.length,
    },
  };
}
