// src/lib/trust-health-v2.js
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§189-192) —
// Trust Health 2.0. A NEW, additive function alongside the existing
// trustHealth.js (Enterprise OS SOW Phase 2) rather than a rewrite of it:
// trustHealth.js's computeTrustHealthSnapshot() has a real shipped
// consumer (TrustHealthCard, confirmed rendering live in the Business
// Workspace dashboard) with its own established output contract. §189
// asks for a genuinely different, richer shape -- ten named dimensions,
// each independently scored and explained -- which would break that
// contract if grafted on in place. This file adds the new capability
// without touching the old one.
//
// THE LOAD-BEARING RULE (§189, §191-192, verbatim): "Never fabricate a
// score." Every dimension below either computes from real data this
// codebase actually has, or returns status:"unknown" with score:null and
// an honest scopeNotes explanation -- exactly compliance-health.js's own
// unknown-vs-passing discipline, applied across all ten dimensions.
//
// §190 Explainability: every dimension's contributingFactors is a list of
// the REAL numbers that produced the status (never generic filler text),
// and remediationLinks point at the actual screen/tab a reviewer would
// use to act on it.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { verifyChainIntegrity } from "./auditChain.js";
import { getPublicSecurityStats } from "./security.js";
import { getComplianceHealth } from "./compliance-health.js";
import { computeOrgDataQualityScores } from "./data-quality.js";
import { getOperationalResilienceDashboard } from "./operational-resilience.js";
import { listVendors } from "./vendor-management.js";
import { listAiActionRequests } from "./ai-action-requests.js";
import { AI_TOOL_REGISTRY } from "./ai-tool-registry.js";
import { listUnreviewedSessions } from "./privileged-access.js";

export const HEALTH_STATUS = { GREEN: "green", AMBER: "amber", RED: "red", UNKNOWN: "unknown" };

function unknownDimension(scopeNotes) {
  return { score: null, status: HEALTH_STATUS.UNKNOWN, contributingFactors: [], scopeNotes, remediationLinks: [] };
}

async function computeSecurityDimension() {
  const stats = await getPublicSecurityStats().catch(() => null);
  if (!stats) return unknownDimension("Platform security stats were not reachable.");
  const status = stats.confirmedThreatsCount > 0 ? HEALTH_STATUS.AMBER : HEALTH_STATUS.GREEN;
  return {
    score: stats.confirmedThreatsCount > 0 ? 0.6 : 1,
    status,
    contributingFactors: [`${stats.confirmedThreatsCount} confirmed threat(s) in the last 24h (platform-wide signal).`],
    scopeNotes: "Platform-wide signal, not filtered to this org — security.js has no org linkage today.",
    remediationLinks: [{ label: "Security", view: "security" }],
  };
}

async function computeDataIntegrityDimension(orgId) {
  const { scores, unscored } = await computeOrgDataQualityScores(orgId);
  if (unscored || scores.length === 0) return unknownDimension(unscored || "No integrations configured yet.");
  const scored = scores.filter((s) => s.consistency !== null);
  if (scored.length === 0) return unknownDimension("Integrations are configured but none have completed a real sync yet.");
  const avgConsistency = scored.reduce((sum, s) => sum + s.consistency, 0) / scored.length;
  const status = avgConsistency >= 0.95 ? HEALTH_STATUS.GREEN : avgConsistency >= 0.8 ? HEALTH_STATUS.AMBER : HEALTH_STATUS.RED;
  return {
    score: avgConsistency, status,
    contributingFactors: [`${scored.length} synced integration(s) averaging ${Math.round(avgConsistency * 100)}% consistency (no conflicts vs. target records).`],
    scopeNotes: "Only reflects integrations that have completed at least one real sync.",
    remediationLinks: [{ label: "Integrations", view: "integrations" }],
  };
}

async function computeAuditIntegrityDimension(orgId) {
  const result = await verifyChainIntegrity(orgId);
  const status = result.valid ? HEALTH_STATUS.GREEN : HEALTH_STATUS.RED;
  return {
    score: result.valid ? 1 : 0, status,
    contributingFactors: result.valid ? ["Audit hash chain verified intact."] : [`Chain broken at sequence ${result.brokenAtSeq}: ${result.reason}`],
    scopeNotes: "Cryptographic hash-chain verification of this org's own audit trail.",
    remediationLinks: [{ label: "Audit Trail", view: "auditTrail" }],
  };
}

function computeBackupHealthDimension() {
  // Honest, deliberate unknown -- same conclusion trustHealth.js's own org
  // scope already reached: asset ownership is wallet-scoped, not
  // org-scoped, so there is no real org-level backup signal to report.
  return unknownDimension("Backup health has no org-level signal in this codebase — asset ownership is wallet-scoped, not org-scoped.");
}

async function computeComplianceHealthDimension(orgId) {
  const health = await getComplianceHealth(orgId);
  const statusMap = { green: HEALTH_STATUS.GREEN, amber: HEALTH_STATUS.AMBER, red: HEALTH_STATUS.RED, unknown: HEALTH_STATUS.UNKNOWN };
  const status = statusMap[health.overallStatus];
  return {
    score: status === HEALTH_STATUS.UNKNOWN ? null : health.totalControls === 0 ? null : health.controlsPassing / health.totalControls,
    status,
    contributingFactors: [
      `${health.controlsPassing} passing / ${health.controlsFailing} failing / ${health.controlsUnknown} unknown of ${health.totalControls} control(s).`,
      `${health.openFindings} open finding(s), ${health.criticalFindings} critical.`,
    ],
    scopeNotes: health.totalControls === 0 ? "No compliance controls exist yet — unknown, not green." : "",
    remediationLinks: [{ label: "Regulated: Controls", view: "regulated" }],
  };
}

async function computeControlHealthDimension(orgId) {
  const { complianceControls } = await getOrgCollections();
  const controls = await complianceControls.find({ orgId: toObjectId(orgId), status: "active" }).toArray();
  if (controls.length === 0) return unknownDimension("No active controls exist yet.");
  const byEffectiveness = { effective: 0, partially_effective: 0, ineffective: 0, not_tested: 0 };
  for (const c of controls) byEffectiveness[c.effectiveness] = (byEffectiveness[c.effectiveness] || 0) + 1;
  const effectivePct = byEffectiveness.effective / controls.length;
  const status = byEffectiveness.ineffective > 0 ? HEALTH_STATUS.RED : byEffectiveness.not_tested > 0 || byEffectiveness.partially_effective > 0 ? HEALTH_STATUS.AMBER : HEALTH_STATUS.GREEN;
  return {
    score: effectivePct, status,
    contributingFactors: [`${byEffectiveness.effective} effective, ${byEffectiveness.partially_effective} partially effective, ${byEffectiveness.ineffective} ineffective, ${byEffectiveness.not_tested} not tested (of ${controls.length} active controls).`],
    scopeNotes: "",
    remediationLinks: [{ label: "Regulated: Controls", view: "regulated" }],
  };
}

async function computeVendorHealthDimension(orgId) {
  const vendors = await listVendors(orgId);
  if (vendors.length === 0) return unknownDimension("No vendors on file yet.");
  const criticalNotMonitoring = vendors.filter((v) => v.criticality === "critical" && v.onboardingStatus !== "MONITORING").length;
  const rejected = vendors.filter((v) => v.onboardingStatus === "REJECTED").length;
  const status = criticalNotMonitoring > 0 ? HEALTH_STATUS.RED : rejected > 0 ? HEALTH_STATUS.AMBER : HEALTH_STATUS.GREEN;
  return {
    score: vendors.filter((v) => v.onboardingStatus === "MONITORING").length / vendors.length,
    status,
    contributingFactors: [`${criticalNotMonitoring} critical vendor(s) not yet fully onboarded (MONITORING).`, `${vendors.length} vendor(s) total.`],
    scopeNotes: "",
    remediationLinks: [{ label: "Trust & Resilience: Vendors", view: "resilience" }],
  };
}

async function computeOperationalResilienceDimension(orgId) {
  const dashboard = await getOperationalResilienceDashboard(orgId);
  if (dashboard.runbookCount === 0 && dashboard.criticalFunctionCount === 0) return unknownDimension("No critical functions or DR runbooks configured yet.");
  const status = dashboard.openIncidentCount > 0 || dashboard.runbooksNeedingAttention.length > 0 ? HEALTH_STATUS.AMBER : HEALTH_STATUS.GREEN;
  return {
    score: dashboard.runbookCount === 0 ? null : (dashboard.runbookCount - dashboard.runbooksNeedingAttention.length) / dashboard.runbookCount,
    status,
    contributingFactors: [`${dashboard.runbooksNeedingAttention.length} runbook(s) needing attention.`, `${dashboard.openIncidentCount} open incident(s).`, `${dashboard.uncoveredTestTypes.length} resilience test type(s) never run.`],
    scopeNotes: "",
    remediationLinks: [{ label: "Trust & Resilience: Disaster Recovery", view: "resilience" }],
  };
}

async function computeAiGovernanceDimension(orgId) {
  const pending = await listAiActionRequests({ orgId, status: "PENDING_APPROVAL" });
  const now = Date.now();
  const stale = pending.filter((r) => new Date(r.proposalExpiresAt).getTime() < now).length;
  // Registry coverage is a fixed, code-level fact, not per-org data -- it
  // always reflects the same governance completeness for every org.
  const registryComplete = AI_TOOL_REGISTRY.every((t) => t.name && t.approvalRequirement !== undefined);
  const status = !registryComplete ? HEALTH_STATUS.RED : pending.some((r) => r.riskLevel === "HIGH") ? HEALTH_STATUS.AMBER : HEALTH_STATUS.GREEN;
  return {
    score: registryComplete ? (pending.some((r) => r.riskLevel === "HIGH") ? 0.7 : 1) : 0,
    status,
    contributingFactors: [`${pending.length} AI action(s) pending approval (${stale} stale).`, `${AI_TOOL_REGISTRY.length} AI tools registered with governance metadata.`],
    scopeNotes: "",
    remediationLinks: [{ label: "AI Action Requests", view: "aiActions" }],
  };
}

async function computeIdentityHealthDimension(orgId) {
  const { orgMembers } = await getOrgCollections();
  const members = await orgMembers.find({ orgId: toObjectId(orgId) }).toArray();
  if (members.length === 0) return unknownDimension("No org members found.");
  const suspended = members.filter((m) => m.status !== "active").length;
  const unreviewedPrivileged = await listUnreviewedSessions(orgId);
  const status = unreviewedPrivileged.length > 0 ? HEALTH_STATUS.AMBER : HEALTH_STATUS.GREEN;
  return {
    score: unreviewedPrivileged.length === 0 ? 1 : 0.7,
    status,
    contributingFactors: [`${unreviewedPrivileged.length} privileged-access session(s) awaiting post-event review.`, `${suspended} of ${members.length} member(s) suspended.`],
    scopeNotes: "",
    remediationLinks: [{ label: "Trust & Resilience: Privileged Access", view: "resilience" }],
  };
}

export async function computeTrustHealth2(orgId) {
  const [security, data_integrity, audit_integrity, compliance_health, control_health, vendor_health, operational_resilience, ai_governance, identity_health] = await Promise.all([
    computeSecurityDimension(),
    computeDataIntegrityDimension(orgId),
    computeAuditIntegrityDimension(orgId),
    computeComplianceHealthDimension(orgId),
    computeControlHealthDimension(orgId),
    computeVendorHealthDimension(orgId),
    computeOperationalResilienceDimension(orgId),
    computeAiGovernanceDimension(orgId),
    computeIdentityHealthDimension(orgId),
  ]);
  const dimensions = { security, data_integrity, audit_integrity, backup_health: computeBackupHealthDimension(), compliance_health, control_health, vendor_health, operational_resilience, ai_governance, identity_health };

  const scored = Object.values(dimensions).filter((d) => d.status !== HEALTH_STATUS.UNKNOWN);
  let overallStatus = HEALTH_STATUS.UNKNOWN;
  if (scored.length > 0) {
    if (scored.some((d) => d.status === HEALTH_STATUS.RED)) overallStatus = HEALTH_STATUS.RED;
    else if (scored.some((d) => d.status === HEALTH_STATUS.AMBER)) overallStatus = HEALTH_STATUS.AMBER;
    else overallStatus = HEALTH_STATUS.GREEN;
  }
  const overallScore = scored.length === 0 ? null : scored.reduce((sum, d) => sum + (d.score ?? 0), 0) / scored.length;

  return {
    orgId: orgId.toString(), computedAt: new Date().toISOString(),
    overallScore, overallStatus,
    dimensionsScored: scored.length, dimensionsTotal: Object.keys(dimensions).length,
    dimensions,
  };
}
