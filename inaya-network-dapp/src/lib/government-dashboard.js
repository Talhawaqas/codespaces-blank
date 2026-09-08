// src/lib/government-dashboard.js
//
// Government & Public Sector Sovereign OS SOW — Phase 2 (§D "Reporting
// and organizational KPIs") and Phase 4 (Security & Compliance Readiness
// dashboard) share one aggregator rather than two near-identical ones,
// since a government org's operational KPIs and its security/compliance
// readiness posture are naturally read together on one screen (same
// consolidation judgment RegulatedView.js's own Dashboard tab already
// makes between compliance-health.js's output and vendor/audit summaries).
//
// THE LOAD-BEARING RULE, same as compliance-health.js (§191-192's
// precedent, carried forward for this SOW too): anything this function
// cannot compute from real data buckets into "unknown", never a
// fabricated "passing"/"green" default. An org with zero cases, zero
// break-glass reviews outstanding, and zero documents doesn't mean
// "everything's fine" -- it means there's nothing to report on yet, and
// this says so honestly rather than defaulting every count to zero-as-good.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { verifyChainIntegrity } from "./auditChain.js";
import { listUnreviewedSessions } from "./privileged-access.js";
import { listExpiringEntries } from "./policy-knowledge-base.js";

export async function getGovernmentDashboard(orgId) {
  const { governmentCases, citizenRecords } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);

  const [cases, records, unreviewedSessions, expiringPolicyEntries, chainIntegrity] = await Promise.all([
    governmentCases.find({ orgId: orgObjectId }).toArray(),
    citizenRecords.find({ orgId: orgObjectId, deletedAt: null }).toArray(),
    listUnreviewedSessions(orgId),
    listExpiringEntries(orgId, { withinDays: 30 }),
    verifyChainIntegrity(orgId),
  ]);

  const openCases = cases.filter((c) => c.status !== "CLOSED");
  const casesByCategory = {};
  for (const c of cases) casesByCategory[c.category] = (casesByCategory[c.category] || 0) + 1;
  const casesByPriority = { low: 0, medium: 0, high: 0, urgent: 0 };
  for (const c of openCases) if (casesByPriority[c.priority] !== undefined) casesByPriority[c.priority] += 1;

  // Average time-to-resolution, computed ONLY over cases that actually
  // have a resolvedAt -- an org with zero resolved cases gets `unknown`,
  // never a fabricated 0-days-to-resolve.
  const resolved = cases.filter((c) => c.resolvedAt);
  const avgResolutionDays = resolved.length === 0
    ? "unknown"
    : Math.round(resolved.reduce((sum, c) => sum + (new Date(c.resolvedAt) - new Date(c.createdAt)) / 86400000, 0) / resolved.length);

  // Break-glass/privileged-access sessions the SOW requires to be
  // reviewed (§C "emergency/break-glass access with immediate logging,
  // expiration and notification") -- surfaced as a first-class readiness
  // signal, not buried.
  const unreviewedBreakGlass = unreviewedSessions.filter((s) => s.grantType === "break_glass");

  // The security posture line: unknown unless the chain has at least one
  // entry AND it verified valid -- an org with a broken chain (however
  // that happened) must never show "healthy" here.
  const auditChainStatus = chainIntegrity.count === 0 ? "unknown" : (chainIntegrity.valid ? "valid" : "COMPROMISED");

  return {
    operations: {
      totalCitizenRecords: records.length,
      totalCases: cases.length,
      openCases: openCases.length,
      casesByCategory,
      casesByPriority,
      avgResolutionDays,
    },
    security: {
      auditChainStatus, // "valid" | "COMPROMISED" | "unknown"
      auditChainEntryCount: chainIntegrity.count,
      unreviewedPrivilegedSessions: unreviewedSessions.length,
      unreviewedBreakGlassGrants: unreviewedBreakGlass.length,
      policyEntriesExpiringSoon: expiringPolicyEntries.length,
    },
    // Explicitly never an aggregate "green/yellow/red" traffic light --
    // that would be exactly the "silently defaults to fine" failure mode
    // §191-192 (and this SOW's own repeated honesty requirement) forbids.
    // The UI shows operations and security as two separate, real panels
    // instead of collapsing them into one score.
  };
}
