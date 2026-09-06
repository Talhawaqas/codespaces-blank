// src/lib/operational-resilience.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§70) —
// Operational Resilience dashboard. Cross-vertical. A thin, read-only
// aggregator, not a new storage system: it pulls critical functions
// (business-continuity.js), supporting ICT assets (ict-asset-inventory.js),
// third parties (vendor-management.js), recovery capability
// (disaster-recovery.js's runbooks/tests), incidents (incidents.js), and
// tests/weaknesses/remediation (resilience-testing.js) -- every section
// is real data from an existing module, never fabricated to fill out the
// dashboard shape. §70 quotes DORA's emphasis on ICT risk management,
// incident reporting, resilience testing, and third-party ICT risk; this
// dashboard is deliberately the one place all of those come together for
// a reviewer, without inventing a parallel "resilience score" this system
// has no honest basis for computing.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { listCriticalFunctions } from "./business-continuity.js";
import { listIctAssets } from "./ict-asset-inventory.js";
import { listVendors } from "./vendor-management.js";
import { listRunbooksNeedingAttention, listRunbooks } from "./disaster-recovery.js";
import { listResilienceTests, listUncoveredTestTypes } from "./resilience-testing.js";
import { listIncidents } from "./incidents.js";

export async function getOperationalResilienceDashboard(orgId) {
  const [criticalFunctions, ictAssets, vendors, runbooks, runbooksNeedingAttention, recentTests, uncoveredTestTypes, openIncidents] = await Promise.all([
    listCriticalFunctions(orgId),
    listIctAssets(orgId),
    listVendors(orgId),
    listRunbooks(orgId),
    listRunbooksNeedingAttention(orgId),
    listResilienceTests(orgId),
    listUncoveredTestTypes(orgId),
    listIncidents(orgId, { status: "OPEN" }),
  ]);

  const criticalVendors = vendors.filter((v) => v.criticality === "critical");
  const criticalAssets = ictAssets.filter((a) => a.criticality === "critical");

  return {
    criticalFunctionCount: criticalFunctions.length,
    ictAssetCount: ictAssets.length,
    criticalAssetCount: criticalAssets.length,
    thirdPartyCount: vendors.length,
    criticalThirdPartyCount: criticalVendors.length,
    runbookCount: runbooks.length,
    runbooksNeedingAttention,
    recentTests: recentTests.slice(0, 10).map((t) => ({ testType: t.testType, scope: t.scope, result: t.result, testedAt: t.testedAt, retestRequired: t.retestRequired })),
    // Weaknesses: tests that failed or still need a retest -- never
    // silently dropped from the dashboard once a later, unrelated test passes.
    weaknesses: recentTests.filter((t) => t.result === "fail" || t.retestRequired),
    uncoveredTestTypes,
    openIncidentCount: openIncidents.length,
  };
}
