// src/lib/activityCenter.js
//
// Enterprise OS SOW, Phase 5 — the generalized "What Changed?" digest.
// Distinct from the existing "Activity" nav item (GET /api/orgs/activity
// — a raw, chronological document_activity log) — this is a periodic,
// cross-module DIGEST, complementary to that raw feed, not a replacement.
//
// Org scope composes business-brief.js's real, shipped
// generateBusinessBrief() output as its business-module section (reused
// verbatim, not reimplemented) and adds sections business-brief.js has
// no data for: AI action outcomes and notification volume by category,
// both counted from real, already-timestamped records (aiActionRequests'
// reviewedAt/executedAt, notifications' createdAt) — genuine
// period-over-period counts, not fabricated deltas.
//
// Trust/health is included as a CURRENT-STATE section, not a diff:
// trustHealth.js computes live, nothing persists historical snapshots,
// so an honest "what changed" here is "here's where things stand right
// now" rather than a claimed delta this codebase can't actually back —
// same discipline as every other "don't claim what you can't prove" note
// throughout this SOW's other phases.
//
// Wallet scope has no existing brief to build on — bullets come from
// real vault-file uploads in the period (metadata_files.createdAt) and
// real wallet-scoped notification volume (Phase 3's notifications
// collection, already populated by real write-hooks like the backup
// state-change one in backupEngine.js).

import { generateBusinessBrief, BRIEF_PERIODS } from "./business-brief.js";
import { computeTrustHealthSnapshot } from "./trustHealth.js";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { connectToDatabase } from "./mongodb.js";

export { BRIEF_PERIODS };

function periodBounds(period) {
  const days = BRIEF_PERIODS[period];
  if (!days) throw new Error(`Unknown period "${period}". Valid periods: ${Object.keys(BRIEF_PERIODS).join(", ")}.`);
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { sinceIso: since.toISOString(), nowIso: now.toISOString() };
}

async function orgAiActionBullets({ orgId, sinceIso }) {
  const { aiActionRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const [executed, rejected, expired] = await Promise.all([
    aiActionRequests.countDocuments({ orgId: orgObjectId, status: "EXECUTED", executedAt: { $gte: sinceIso } }),
    aiActionRequests.countDocuments({ orgId: orgObjectId, status: "REJECTED", reviewedAt: { $gte: sinceIso } }),
    aiActionRequests.countDocuments({ orgId: orgObjectId, status: "EXPIRED" }),
  ]);
  const bullets = [];
  if (executed > 0) bullets.push(`${executed} AI-proposed action${executed === 1 ? "" : "s"} executed after approval + the 36h delay.`);
  if (rejected > 0) bullets.push(`${rejected} AI-proposed action${rejected === 1 ? "" : "s"} rejected.`);
  return bullets;
}

async function notificationVolumeBullets({ scope, orgId, walletAddress, sinceIso }) {
  const { db } = await connectToDatabase();
  const filter =
    scope === "org"
      ? { scope: "org", orgId: toObjectId(orgId), createdAt: { $gte: sinceIso } }
      : { scope: "wallet", walletAddress: walletAddress.toLowerCase(), createdAt: { $gte: sinceIso } };
  const byCategory = await db
    .collection("notifications")
    .aggregate([{ $match: filter }, { $group: { _id: "$category", count: { $sum: 1 } } }])
    .toArray();
  if (byCategory.length === 0) return [];
  const parts = byCategory.map((c) => `${c.count} ${c._id}`).join(", ");
  return [`New notifications this period: ${parts}.`];
}

async function walletFileUploadBullets({ walletAddress, sinceIso }) {
  const { db } = await connectToDatabase();
  const count = await db
    .collection("metadata_files")
    .countDocuments({ owner: walletAddress.toLowerCase(), deletedAt: null, createdAt: { $gte: sinceIso } });
  return count > 0 ? [`${count} new file${count === 1 ? "" : "s"} added to the Sovereign Vault this period.`] : [];
}

function trustHealthBullets(snapshot) {
  if (!snapshot) return [];
  const bullets = [`Overall trust & health status: ${snapshot.overallStatus}.`];
  if (snapshot.scope === "org") {
    if (!snapshot.auditTrail?.intact) bullets.push(`Audit trail integrity check failed at entry #${snapshot.auditTrail?.brokenAtSeq}.`);
    if (snapshot.aiActions?.pendingHighRisk > 0) bullets.push(`${snapshot.aiActions.pendingHighRisk} high-risk AI action(s) awaiting approval.`);
  } else {
    if (snapshot.backup?.assetsNeedingRecovery > 0) bullets.push(`${snapshot.backup.assetsNeedingRecovery} asset(s) currently need backup recovery.`);
    if (snapshot.security?.recentBlocked > 0) bullets.push(`${snapshot.security.recentBlocked} recent blocked threat event(s) for this wallet.`);
  }
  return bullets;
}

async function generateOrgWhatChanged({ orgId, membership, email, period, orgName }) {
  const { sinceIso } = periodBounds(period);
  const [brief, trustSnapshot, aiBullets, notifBullets] = await Promise.all([
    generateBusinessBrief({ orgId, membership, email, period, orgName, includeNarrative: false }),
    computeTrustHealthSnapshot({ scope: "org", orgId, membership, email }).catch(() => null),
    orgAiActionBullets({ orgId, sinceIso }).catch(() => []),
    notificationVolumeBullets({ scope: "org", orgId, sinceIso }).catch(() => []),
  ]);

  return {
    scope: "org",
    period,
    generatedAt: new Date().toISOString(),
    sections: [
      { module: "business", bullets: brief.error ? [] : brief.highlights },
      { module: "ai", bullets: aiBullets },
      { module: "notifications", bullets: notifBullets },
      { module: "trust", bullets: trustHealthBullets(trustSnapshot) },
    ],
  };
}

async function generateWalletWhatChanged({ walletAddress, period }) {
  const { sinceIso } = periodBounds(period);
  const [trustSnapshot, fileBullets, notifBullets] = await Promise.all([
    computeTrustHealthSnapshot({ scope: "wallet", walletAddress }).catch(() => null),
    walletFileUploadBullets({ walletAddress, sinceIso }).catch(() => []),
    notificationVolumeBullets({ scope: "wallet", walletAddress, sinceIso }).catch(() => []),
  ]);

  return {
    scope: "wallet",
    period,
    generatedAt: new Date().toISOString(),
    sections: [
      { module: "data", bullets: fileBullets },
      { module: "notifications", bullets: notifBullets },
      { module: "trust", bullets: trustHealthBullets(trustSnapshot) },
    ],
  };
}

/** generateWhatChanged({scope:"org", orgId, membership, email, period, orgName})
 *  or generateWhatChanged({scope:"wallet", walletAddress, period}). */
export async function generateWhatChanged(input) {
  if (input?.scope === "org") return generateOrgWhatChanged(input);
  if (input?.scope === "wallet") return generateWalletWhatChanged(input);
  throw new Error('generateWhatChanged: scope must be "org" or "wallet".');
}
