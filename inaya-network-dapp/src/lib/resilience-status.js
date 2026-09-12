// src/lib/resilience-status.js
//
// Autonomous Resilience Layer SOW, Phase 7 — derives the SOW's own five
// states (VERIFIED / DEGRADED / FAILED / UNKNOWN / TEST DUE) per policy
// from real data: its latest completed test run + whether the test
// window has elapsed. Never asserted, always computed -- matches this
// codebase's "don't present an institution as resilient merely because
// backups exist" discipline literally.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { listPolicies } from "./resilience-policy.js";
import { getLatestTestRun, listTestRuns } from "./resilience-orchestrator.js";

const FREQUENCY_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000, monthly: 30 * 24 * 60 * 60 * 1000 };

export const RESILIENCE_STATES = ["VERIFIED", "DEGRADED", "FAILED", "UNKNOWN", "TEST_DUE"];

export function deriveState(policy, latestTestRun) {
  if (!latestTestRun) return "UNKNOWN";

  const intervalMs = FREQUENCY_MS[policy.testFrequency] || FREQUENCY_MS.daily;
  const isOverdue = Date.now() - new Date(latestTestRun.completedAt).getTime() > intervalMs;
  if (isOverdue) return "TEST_DUE";

  if (latestTestRun.overallResult === "PASS") return "VERIFIED";

  // FAILED only for a hard requirement miss (RTO/RPO breach, or a
  // critical-priority asset failing); a non-critical asset failing while
  // everything else holds reads as DEGRADED, not a full FAILED -- matches
  // backupHealth.js's own "worst-of-both, but grade the severity" spirit.
  const criticalAssetFailed = (latestTestRun.assetResults || []).some((a) => {
    const category = policy.criticalAssetCategories.find((c) => c.label === a.categoryLabel);
    const isCritical = category?.priority === "CRITICAL";
    const assetFailed = !a.recovered || !a.integrityPass || !a.permissionPass || !a.dependencyOk;
    return isCritical && assetFailed;
  });
  if (!latestTestRun.rtoPass || !latestTestRun.rpoPass || criticalAssetFailed) return "FAILED";
  return "DEGRADED";
}

export async function getResilienceStatus(orgId) {
  const { policies } = await listPolicies({ orgId });
  const results = [];
  for (const policy of policies) {
    const { testRun: latestTestRun } = await getLatestTestRun({ orgId, policyId: policy.policyId });
    results.push({
      policyId: policy.policyId, name: policy.name, status: policy.status,
      requiredRTOMinutes: policy.requiredRTOMinutes, requiredRPOMinutes: policy.requiredRPOMinutes,
      criticalAssetCategories: policy.criticalAssetCategories, testFrequency: policy.testFrequency,
      resilienceState: policy.status === "PAUSED" ? "UNKNOWN" : deriveState(policy, latestTestRun),
      latestTestRun,
    });
  }
  return { policies: results };
}

export async function getPolicyHistory({ orgId, policyId }) {
  const { testRuns } = await listTestRuns({ orgId, policyId, limit: 20 });
  return { testRuns };
}
