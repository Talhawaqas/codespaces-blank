// src/lib/nas/compliance.js
//
// Sovereign NAS SOW Workstream Y: the NAS compliance evidence package. It is a
// section of the EXISTING evidence exporter (evidenceExporter.js), not a
// second exporter: buildEvidencePackage() calls gatherNasEvidence() and puts
// the result under `nasEvidence`, so it is hashed, canonicalised and exported
// exactly like every other section.
//
// It reports technical controls and their state. It never claims a legal or
// regulatory certification (HIPAA, ISO, FedRAMP...): technical controls are not
// certification, and the package says so.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { verifyChainIntegrity } from "../auditChain.js";
import { accessPolicyHash } from "./access.js";
import { recoveryReadiness } from "./backup.js";
import { replicationHealth } from "./replication.js";
import { canonicalHash } from "../documentAutomation/manifest.js";

const DISCLAIMER = "This package lists technical controls and their recorded state. It is not a compliance certification and makes no claim of HIPAA, ISO, SOC, FedRAMP or any other certification.";

export async function gatherNasEvidence(orgId, { applianceId = null } = {}) {
  const c = await getOrgCollections();
  const orgObj = toObjectId(orgId);
  const q = { orgId: orgObj, deletedAt: null };
  if (applianceId) q._id = toObjectId(applianceId);
  const appliances = await c.nasAppliances.find(q, { projection: { adminCredential: 0 } }).toArray();
  if (!appliances.length) return { appliances: [], disclaimer: DISCLAIMER };
  const out = [];
  for (const a of appliances) {
    const shares = await c.nasShares.find({ orgId: orgObj, applianceId: a._id, deletedAt: null }).toArray();
    const ids = shares.map((s) => s._id);
    const [snapPolicies, backupPolicies, repPolicies, threats, drills, state, latestCommit, evidenceRows, users] = await Promise.all([
      c.nasSnapshotPolicies.find({ orgId: orgObj, shareId: { $in: ids } }).toArray(),
      c.nasBackupPolicies.find({ orgId: orgObj, shareId: { $in: ids } }).toArray(),
      c.nasReplicationPolicies.find({ orgId: orgObj, shareId: { $in: ids } }).toArray(),
      c.nasThreatEvents.find({ orgId: orgObj, shareId: { $in: ids } }).sort({ detectedAt: -1 }).limit(50).toArray(),
      c.nasRecoveryDrills.find({ orgId: orgObj, shareId: { $in: ids } }).sort({ startedAt: -1 }).limit(20).toArray(),
      c.nasApplianceState.findOne({ orgId: orgObj, applianceId: a._id }),
      c.nasStateCommitments.find({ orgId: orgObj, applianceId: a._id }).sort({ createdAt: -1 }).limit(1).next(),
      c.nasEvidence.find({ orgId: orgObj, applianceId: a._id }).sort({ createdAt: -1 }).limit(100).toArray(),
      c.nasUsers.countDocuments({ orgId: orgObj, applianceId: a._id, revokedAt: null }),
    ]);
    const inventory = [];
    for (const s of shares) {
      const readiness = await recoveryReadiness({ orgId, shareId: s._id });
      const lastBackup = await c.nasBackupRuns.find({ orgId: orgObj, shareId: s._id, status: "COMPLETED" }).sort({ startedAt: -1 }).limit(1).next();
      const snaps = await c.nasSnapshots.countDocuments({ orgId: orgObj, shareId: s._id, state: "AVAILABLE" });
      inventory.push({
        share: s.shareName, backend: s.backend || "dir", protocols: { smb: true, nfs: !!s.protocols?.nfs?.enabled }, accessPolicyHash: accessPolicyHash(s), accessEntries: (s.access?.entries || []).length,
        quota: s.quota ? { hardBytes: s.quota.hardBytes, enforced: s.quota.enforced, mechanism: s.quota.mechanism } : null,
        immutableRetention: s.worm?.enabled ? { mode: s.worm.mode, retentionDays: s.worm.retentionDays, lockExpiry: s.worm.lockExpiry, grade: "governance-grade (root on the appliance can lift the flag)" } : null,
        snapshots: snaps, latestVerifiedBackup: lastBackup ? { at: lastBackup.completedAt, recoveryManifestHash: lastBackup.recoveryPoint?.manifestHash || null, filesVerified: lastBackup.filesVerified } : null, recoveryReadiness: readiness.state,
        threatPolicy: s.threatPolicy ? { enabled: s.threatPolicy.enabled, autoLockdown: s.threatPolicy.autoLockdown } : null,
      });
    }
    const chain = await verifyChainIntegrity(orgId).catch((e) => ({ valid: false, reason: e.message }));
    out.push({
      appliance: { id: String(a._id), name: a.name, backend: a.backend, status: a.status, remoteAccess: a.remoteAccess?.mode || "UNCONFIGURED", lockoutPolicy: a.lockoutPolicy || null },
      storageConfigurationFingerprint: latestCommit ? { stateHash: latestCommit.stateHash, committedAt: latestCommit.createdAt } : null,
      lastMeasuredState: state ? { checkedAt: state.checkedAt, pools: (state.pools || []).map((p) => ({ pool: p.pool, level: p.level, health: p.health })), servicesUp: state.services } : null,
      accounts: { activeNasAccounts: users },
      shareInventory: inventory,
      policies: { snapshot: snapPolicies.map((p) => ({ shareId: String(p.shareId), intervalMinutes: p.intervalMinutes, keepLast: p.keepLast, immutable: p.immutable, retentionDays: p.retentionDays })), backup: backupPolicies.map((p) => ({ shareId: String(p.shareId), intervalMinutes: p.intervalMinutes, targets: p.targetIds, verify: p.verify })) },
      replicationHealth: repPolicies.map((p) => ({ shareId: String(p.shareId), mode: p.mode, transport: p.transport, health: replicationHealth(p), lastSuccessAt: p.lastSuccessAt })),
      recoveryTests: drills.map((d) => ({ shareId: String(d.shareId), at: d.startedAt, verified: !!d.result?.verified, filesTested: d.result?.filesTested ?? null })),
      securityEvents: threats.map((t) => ({ shareId: String(t.shareId), level: t.level, state: t.state, detectedAt: t.detectedAt, protection: { snapshot: t.protection?.snapshot?.name || null, lockdown: t.protection?.lockdown?.state || null } })),
      cryptographicEvidenceReferences: evidenceRows.map((e) => ({ evidenceId: String(e._id), action: e.action, rowHash: e.rowHash, auditSeq: e.auditRef?.seq ?? null, auditEntryHash: e.auditRef?.entryHash ?? null, integrityHash: e.integrityHash })),
      evidenceReferenceDigest: canonicalHash(evidenceRows.map((e) => e.rowHash)),
      auditChainVerification: { valid: chain.valid, entries: chain.count ?? null, reason: chain.reason || null },
    });
  }
  return { appliances: out, disclaimer: DISCLAIMER };
}
