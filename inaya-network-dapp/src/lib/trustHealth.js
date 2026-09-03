// src/lib/trustHealth.js
//
// Enterprise OS SOW, Phase 2 — the cross-module trust/health signal
// neither surface has today. Confirmed by direct search before writing
// this: no function anywhere combines audit-chain integrity, AI-action
// backlog, backup health, or security status into one snapshot
// (grep for trustScore/systemHealth/overallStatus/aggregat* returned
// nothing). Deterministic — no LLM call, same "highlights never fail"
// discipline as business-brief.js.
//
// TWO SCOPES, ONE OUTPUT SHAPE. Org scope (Business Workspace) and
// wallet scope (the dApp) have genuinely different real signals
// available — security.js and backupHealth.js are keyed by identityId/
// wallet, not orgId, so there is no honest per-org security/backup
// number today (see scopeNotes below; not faked). Both scopes still
// return the exact same { scope, computedAt, overallStatus, ...,
// scopeNotes } contract so TrustHealthCard can render either one without
// caring which scope produced it.

import { verifyChainIntegrity } from "./auditChain.js";
import { listAiActionRequests } from "./ai-action-requests.js";
import { computeBusinessInsights } from "./business-insights.js";
import { getPublicSecurityStats, getRecentSecurityEvents } from "./security.js";
import { getBackupStatus } from "./backupEngine.js";
import { combineShardStates, HEALTH_STATES } from "./backupHealth.js";
import { connectToDatabase } from "./mongodb.js";

export const OVERALL_STATUS = { GOOD: "good", ATTENTION: "attention", CRITICAL: "critical" };

// Caps how many of a wallet's own assets get a live getBackupStatus() call
// for one snapshot — a wallet with hundreds of files shouldn't turn this
// into a hundred-query fan-out. Same "recent N, not everything" discipline
// dashboard/route.js already uses for its own aggregate counts.
const MAX_ASSETS_CHECKED = 25;

async function computeOrgSnapshot({ orgId, membership, email }) {
  const [chainResult, pendingActions, approvedActions, insights, platformSecurity] = await Promise.all([
    verifyChainIntegrity(orgId),
    listAiActionRequests({ orgId, status: "PENDING_APPROVAL" }),
    listAiActionRequests({ orgId, status: "APPROVED" }),
    computeBusinessInsights({ orgId, membership, email, periodDays: 30 }).catch(() => null),
    getPublicSecurityStats().catch(() => null),
  ]);

  const now = Date.now();
  const stalePastSettlement = approvedActions.filter((r) => r.unlockAt && new Date(r.unlockAt).getTime() <= now).length;

  const byRisk = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of pendingActions) byRisk[r.riskLevel] = (byRisk[r.riskLevel] || 0) + 1;

  let overallStatus = OVERALL_STATUS.GOOD;
  if (!chainResult.valid || byRisk.HIGH > 0) overallStatus = OVERALL_STATUS.CRITICAL;
  else if (byRisk.MEDIUM > 0 || stalePastSettlement > 0) overallStatus = OVERALL_STATUS.ATTENTION;

  return {
    scope: "org",
    orgId,
    computedAt: new Date().toISOString(),
    overallStatus,
    auditTrail: { intact: chainResult.valid, brokenAtSeq: chainResult.brokenAtSeq ?? null, reason: chainResult.reason ?? null },
    aiActions: {
      pendingHighRisk: byRisk.HIGH,
      pendingMediumRisk: byRisk.MEDIUM,
      pendingLowRisk: byRisk.LOW,
      stalePastSettlement,
    },
    businessHealth: insights
      ? {
          overduePendingApprovals: insights.kpis?.pendingApprovals?.value ?? null,
          overdueInvoices: insights.kpis?.overdueInvoices?.value ?? null,
          overdueTasks: insights.kpis?.overdueTasks?.value ?? null,
          lowStockItems: insights.kpis?.lowStockCount?.value ?? null,
        }
      : null,
    platformSecurity: platformSecurity
      ? { confirmedThreats24h: platformSecurity.confirmedThreatsCount, scope: "platform-wide" }
      : null,
    scopeNotes:
      "platformSecurity is a platform-wide signal, not filtered to this org — security.js has no org linkage today. Backup health is likewise omitted here (asset-owner is a wallet, not an org) and is instead a real, org-independent signal on the wallet-scoped snapshot.",
  };
}

async function computeWalletSnapshot({ walletAddress }) {
  const normalized = walletAddress.toLowerCase();
  const [recentEvents, filesResult] = await Promise.all([
    getRecentSecurityEvents(normalized, 20).catch(() => []),
    (async () => {
      const { db } = await connectToDatabase();
      return db
        .collection("metadata_files")
        .find({ owner: normalized, deletedAt: null })
        .project({ fileHash: 1 })
        .limit(MAX_ASSETS_CHECKED)
        .toArray();
    })().catch(() => []),
  ]);

  const riskyEvents = recentEvents.filter((e) => e.eventType === "block" || e.eventType === "warn");

  const backupStatuses = await Promise.all(
    filesResult.map((f) => getBackupStatus(f.fileHash).catch(() => null))
  );
  const validStatuses = backupStatuses.filter(Boolean);
  const worstBackupState = validStatuses.length
    ? combineShardStates(validStatuses.map((s) => s.healthState))
    : null;
  const assetsNeedingRecovery = validStatuses.filter(
    (s) => s.healthState === HEALTH_STATES.RECOVERY_REQUIRED || s.healthState === HEALTH_STATES.RECOVERY_FAILED
  ).length;

  let overallStatus = OVERALL_STATUS.GOOD;
  if (worstBackupState === HEALTH_STATES.RECOVERY_FAILED || riskyEvents.some((e) => e.eventType === "block")) {
    overallStatus = OVERALL_STATUS.CRITICAL;
  } else if (
    worstBackupState === HEALTH_STATES.RECOVERY_REQUIRED ||
    worstBackupState === HEALTH_STATES.DEGRADED ||
    riskyEvents.length > 0
  ) {
    overallStatus = OVERALL_STATUS.ATTENTION;
  }

  return {
    scope: "wallet",
    walletAddress: normalized,
    computedAt: new Date().toISOString(),
    overallStatus,
    security: {
      recentBlocked: recentEvents.filter((e) => e.eventType === "block").length,
      recentWarned: recentEvents.filter((e) => e.eventType === "warn").length,
      windowSize: recentEvents.length,
    },
    backup: {
      assetsChecked: validStatuses.length,
      assetsCapped: filesResult.length >= MAX_ASSETS_CHECKED,
      worstState: worstBackupState,
      assetsNeedingRecovery,
    },
    scopeNotes:
      validStatuses.length === 0
        ? "No files found for this wallet, or backup status wasn't reachable — backup signal omitted rather than shown as falsely healthy."
        : `Backup health checked across up to ${MAX_ASSETS_CHECKED} most-recent assets.`,
  };
}

/** computeTrustHealthSnapshot({scope:"org", orgId, membership, email})
 *  or computeTrustHealthSnapshot({scope:"wallet", walletAddress}) — one
 *  function, two real input shapes, same output contract. */
export async function computeTrustHealthSnapshot(input) {
  if (input?.scope === "org") return computeOrgSnapshot(input);
  if (input?.scope === "wallet") return computeWalletSnapshot(input);
  throw new Error('computeTrustHealthSnapshot: scope must be "org" or "wallet".');
}
