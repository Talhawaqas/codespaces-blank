// src/lib/nas/twin.js
//
// Sovereign NAS SOW Workstream W: NAS What-If scenarios on the EXISTING
// Digital Twin engine (digitalTwinSimulate.js). No second simulator: these are
// handlers registered into its scenario table, returning the same
// { scenario, directImpact, indirectImpact, unknowns, resultStatus } shape.
//
// Read-only by construction: the handlers read stored records and the last
// measured appliance state (nasApplianceState). They never call the appliance
// agent and never import a mutating function, so a simulation cannot change
// the live NAS (tested by comparing state before and after).
//
// Honesty (SOW 30 / 50): every result carries `currentState` and
// `simulatedState`, lists UNKNOWNS explicitly (for example recovery duration,
// which has no measured basis), is marked as a model of stored state rather
// than a prediction, and only reports consequences that stored data supports.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canAccessNAS } from "../orgGates.js";

export const NAS_SCENARIO_TYPES = ["NAS_APPLIANCE_UNAVAILABLE", "NAS_DISK_FAILED", "NAS_DATASET_ENCRYPTED", "NAS_USER_ACCESS_REVOKED", "NAS_CAPACITY_EXHAUSTED"];
const DISCLAIMER = "This is a model built from stored NAS state, not a guaranteed prediction. Nothing on the live NAS was changed.";

const unknown = (area, reason) => ({ area, status: "UNKNOWN", reason });
const denied = () => ({ error: "You don't have permission to simulate this.", status: 403 });
const notFound = (what) => ({ error: `${what} not found.`, status: 404 });

async function stateFor(orgId, applianceId) {
  const { nasApplianceState } = await getOrgCollections();
  return nasApplianceState.findOne({ orgId: toObjectId(orgId), applianceId: toObjectId(applianceId) });
}

function shareProtection(s) {
  return { lastVerifiedBackupAt: s.lastBackup?.at || null, backupManifest: s.lastBackup?.manifestHash || null, wormEnabled: !!s.worm?.enabled, lockedDown: !!s.access?.lockdown?.active };
}

async function simulateApplianceUnavailable({ orgId, entityId, membership }) {
  if (!canAccessNAS(membership)) return denied();
  const { nasAppliances, nasShares, nasReplicationPolicies, nasRecoveryDrills } = await getOrgCollections();
  const appliance = await nasAppliances.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId), deletedAt: null });
  if (!appliance) return notFound("Appliance");
  const shares = await nasShares.find({ orgId: toObjectId(orgId), applianceId: appliance._id, deletedAt: null }).toArray();
  const reps = await nasReplicationPolicies.find({ orgId: toObjectId(orgId), shareId: { $in: shares.map((s) => s._id) }, enabled: true }).toArray();
  const stored = await stateFor(orgId, entityId);
  const perShare = [];
  for (const s of shares) {
    const drill = await nasRecoveryDrills.find({ orgId: toObjectId(orgId), shareId: s._id, "result.verified": true }).sort({ startedAt: -1 }).limit(1).next();
    const rs = reps.filter((r) => String(r.shareId) === String(s._id));
    perShare.push({ shareId: String(s._id), share: s.shareName, becomesUnavailable: true, ...shareProtection(s), replicas: rs.map((r) => ({ mode: r.mode, lastSuccessAt: r.lastSuccessAt, transport: r.transport || null })), lastSuccessfulRecoveryDrillAt: drill?.startedAt || null, recoveryTargets: [s.lastBackup ? "Inaya backup" : null, ...rs.map((r) => (r.mode === "nas-to-nas" ? "replica appliance" : null))].filter(Boolean) });
  }
  const unprotected = perShare.filter((p) => !p.lastVerifiedBackupAt && !p.replicas.length);
  return {
    scenario: { type: "NAS_APPLIANCE_UNAVAILABLE", subject: { type: "NAS_APPLIANCE", id: entityId, name: appliance.name } },
    currentState: { status: appliance.status, shares: shares.length, lastMeasuredAt: stored?.checkedAt || null },
    simulatedState: { status: "UNREACHABLE", unavailableShares: shares.map((s) => s.shareName) },
    directImpact: { status: shares.length ? "IMPACT_DETECTED" : "NO_IMPACT", unavailableShares: perShare.map((p) => p.share), sharesWithNoRecoveryCopy: unprotected.map((p) => p.share), perShare },
    indirectImpact: { note: "Local file access stops; cloud-side copies and replicas (where they exist) remain the recovery sources." },
    unknowns: [unknown("RECOVERY_DURATION", "No measured restore throughput exists for this appliance; a duration would be invented."), unknown("CLIENT_IMPACT", "Which users or applications depend on these shares is not tracked."), unknown("REPLICA_FRESHNESS_AT_FAILURE", "Replica age at the moment of failure depends on when it happens.")],
    resultStatus: unprotected.length ? "PARTIAL" : "COMPLETE", disclaimer: DISCLAIMER, noChangesWereMade: true,
  };
}

async function simulateDiskFailed({ orgId, entityId, membership, member = 1 }) {
  if (!canAccessNAS(membership)) return denied();
  const { nasPools, nasShares } = await getOrgCollections();
  const pool = await nasPools.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId), deletedAt: null });
  if (!pool) return notFound("Pool");
  const stored = await stateFor(orgId, pool.applianceId);
  const live = stored?.pools?.find((p) => p.pool === pool.name) || null;
  const shares = await nasShares.find({ orgId: toObjectId(orgId), applianceId: pool.applianceId, poolId: pool._id, deletedAt: null }).toArray();
  const redundant = pool.level === "raid1";
  const alreadyDegraded = !!live?.degraded;
  const dataAtRisk = !redundant || alreadyDegraded;
  return {
    scenario: { type: "NAS_DISK_FAILED", subject: { type: "STORAGE_POOL", id: entityId, name: pool.name } },
    currentState: { level: pool.level, health: live?.health || "UNKNOWN", degraded: alreadyDegraded, measuredAt: stored?.checkedAt || null },
    simulatedState: { health: redundant && !alreadyDegraded ? "DEGRADED" : "FAILED", dataReadable: redundant && !alreadyDegraded, redundancyRemaining: redundant && !alreadyDegraded ? "none (single surviving copy)" : "none" },
    directImpact: {
      status: shares.length ? "IMPACT_DETECTED" : "NO_IMPACT", failedMember: Number(member),
      poolState: redundant && !alreadyDegraded ? "DEGRADED: still online on the surviving mirror member" : "FAILED: no surviving copy of this pool's data",
      affectedDatasets: shares.map((s) => ({ share: s.shareName, ...shareProtection(s) })),
      redundancyImpact: redundant ? "The mirror absorbs one member failure; a second failure before the rebuild finishes loses the pool." : "A single-device pool has no redundancy: this failure loses the data on it.",
      recoveryRequirements: redundant ? ["Replace the failed member and let the mirror rebuild", "Keep the pool's latest backup available until the rebuild completes"] : ["Restore every share from backup/replica onto a new pool"],
      backupAvailability: shares.map((s) => ({ share: s.shareName, hasVerifiedBackup: !!s.lastBackup })),
      dataAtRisk,
    },
    unknowns: [unknown("REBUILD_DURATION", "Rebuild time depends on real disk throughput, which is not measured for this virtual pool."), unknown("PHYSICAL_DISK_HEALTH", "Virtual disks expose no SMART data, so early-failure signals are unavailable.")],
    resultStatus: "COMPLETE", disclaimer: DISCLAIMER, noChangesWereMade: true,
  };
}

async function simulateDatasetEncrypted({ orgId, entityId, membership }) {
  if (!canAccessNAS(membership)) return denied();
  const { nasShares, nasSnapshots, nasBackupRuns, nasReplicationPolicies } = await getOrgCollections();
  const share = await nasShares.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId), deletedAt: null });
  if (!share) return notFound("Share");
  const snaps = await nasSnapshots.find({ orgId: toObjectId(orgId), shareId: share._id, state: "AVAILABLE" }).sort({ createdAt: -1 }).limit(20).toArray();
  const now = new Date();
  const immutable = snaps.filter((s) => s.immutable && s.retentionUntil && new Date(s.retentionUntil) > now);
  const lastBackup = await nasBackupRuns.find({ orgId: toObjectId(orgId), shareId: share._id, status: "COMPLETED" }).sort({ startedAt: -1 }).limit(1).next();
  const reps = await nasReplicationPolicies.find({ orgId: toObjectId(orgId), shareId: share._id, enabled: true }).toArray();
  const cleanCandidate = snaps.find((s) => s.source !== "threat") || null;
  const steps = [];
  if (immutable.length) steps.push(`Restore from immutable snapshot "${immutable[0].name}" into .restored/ and compare, then copy back`);
  else if (cleanCandidate) steps.push(`Restore from snapshot "${cleanCandidate.name}" (NOT immutable: ransomware with admin access could have removed it)`);
  if (lastBackup) steps.push("Restore the affected files from the last verified Inaya backup recovery point");
  if (!steps.length) steps.push("No snapshot or backup exists: there is no recovery path from stored state");
  return {
    scenario: { type: "NAS_DATASET_ENCRYPTED", subject: { type: "NAS_SHARE", id: entityId, name: share.shareName } },
    currentState: { protection: shareProtection(share), snapshots: snaps.length, immutableSnapshots: immutable.length, threatPolicyEnabled: !!share.threatPolicy?.enabled },
    simulatedState: { shareContent: "ENCRYPTED (simulated)", affectedShares: [share.shareName] },
    directImpact: {
      status: "IMPACT_DETECTED", immutableRecoveryPoints: immutable.map((s) => ({ name: s.name, createdAt: s.createdAt, lockedUntil: s.retentionUntil, manifestHash: s.manifestHash })),
      lastKnownCleanState: cleanCandidate ? { snapshot: cleanCandidate.name, createdAt: cleanCandidate.createdAt } : null, lastVerifiedBackup: lastBackup ? { runId: String(lastBackup._id), at: lastBackup.completedAt } : null,
      expectedRestorationPath: steps,
      replicationRisk: reps.length ? "A replica can copy encrypted files if replication runs before the attack is noticed; the replica retains its earlier state only if a snapshot protects it." : null,
    },
    unknowns: [unknown("DETECTION_DELAY", "How long an attack would run before threat detection notices depends on the scan interval and the attack."), unknown("RESTORE_DURATION", "No measured restore throughput exists."), unknown("WHETHER_BACKUP_IS_CLEAN", "A backup taken after encryption would contain encrypted files; recovery points are chosen by their timestamps.")],
    resultStatus: immutable.length || lastBackup ? "COMPLETE" : "PARTIAL", disclaimer: DISCLAIMER, noChangesWereMade: true,
  };
}

async function simulateUserAccessRevoked({ orgId, entityId, membership }) {
  if (!canAccessNAS(membership)) return denied();
  const { nasUsers, nasShares, nasGroups, nasAcls } = await getOrgCollections();
  const user = await nasUsers.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId), revokedAt: null });
  if (!user) return notFound("NAS account");
  const groups = await nasGroups.find({ orgId: toObjectId(orgId), applianceId: user.applianceId, deletedAt: null, members: user._id }).toArray();
  const groupIds = groups.map((g) => g._id);
  const shares = await nasShares.find({ orgId: toObjectId(orgId), applianceId: user.applianceId, deletedAt: null }).toArray();
  const direct = []; const inherited = [];
  for (const s of shares) {
    for (const e of s.access?.entries || []) {
      if (e.principalType === "user" && String(e.principalId) === String(user._id)) direct.push({ share: s.shareName, level: e.level });
      if (e.principalType === "group" && groupIds.some((g) => String(g) === String(e.principalId))) inherited.push({ share: s.shareName, level: e.level, viaGroup: groups.find((g) => String(g._id) === String(e.principalId))?.unixGroup });
    }
  }
  const acls = await nasAcls.find({ orgId: toObjectId(orgId), "entries.principalId": user._id }).toArray();
  const stored = await stateFor(orgId, user.applianceId);
  return {
    scenario: { type: "NAS_USER_ACCESS_REVOKED", subject: { type: "NAS_USER", id: entityId, name: user.memberEmail || user.unixUsername } },
    currentState: { account: user.unixUsername, disabled: !!user.disabledAt, directGrants: direct.length, groups: groups.map((g) => g.unixGroup) },
    simulatedState: { account: "REVOKED", remainingAccess: "none" },
    directImpact: { status: direct.length || inherited.length || acls.length ? "IMPACT_DETECTED" : "NO_IMPACT", sharesLosingDirectAccess: direct, sharesLosingInheritedAccess: inherited, folderAclsReferencingUser: acls.map((a) => ({ shareId: String(a.shareId), relPath: a.relPath })), activeSessions: { count: stored?.metrics?.smbSessions?.value ?? null, label: stored?.metrics?.smbSessions?.measurement || "UNKNOWN", note: "Total SMB sessions at the last measurement; per-user sessions are only visible live." } },
    indirectImpact: { note: "Revoking closes the user's live sessions and disables the login on the appliance. Files the user created stay in place and keep their owner." },
    unknowns: [unknown("DOWNSTREAM_APPLICATIONS", "Applications using this login are not tracked."), unknown("USER_OWNED_DATA_HANDOVER", "Which files need a new owner is not tracked.")],
    resultStatus: "COMPLETE", disclaimer: DISCLAIMER, noChangesWereMade: true,
  };
}

async function simulateCapacityExhausted({ orgId, entityId, membership, percent = 95 }) {
  if (!canAccessNAS(membership)) return denied();
  const { nasAppliances, nasShares, nasSnapshots, nasTieringProposals, nasBackupPolicies } = await getOrgCollections();
  const appliance = await nasAppliances.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId), deletedAt: null });
  if (!appliance) return notFound("Appliance");
  const pct = Math.min(100, Math.max(1, Number(percent) || 95));
  const stored = await stateFor(orgId, entityId);
  const root = stored?.metrics?.nasRootUsage;
  const pools = stored?.pools || [];
  const source = pools.find((p) => p.capacity) || null;
  const total = source?.capacity?.totalBytes ?? root?.totalBytes ?? null;
  const used = source?.capacity?.usedBytes ?? root?.usedBytes ?? null;
  const shares = await nasShares.find({ orgId: toObjectId(orgId), applianceId: appliance._id, deletedAt: null }).toArray();
  const snaps = await nasSnapshots.countDocuments({ orgId: toObjectId(orgId), applianceId: appliance._id, state: "AVAILABLE" });
  const props = await nasTieringProposals.find({ orgId: toObjectId(orgId), applianceId: appliance._id, state: { $in: ["PROPOSED", "APPROVED"] } }).toArray();
  const policies = await nasBackupPolicies.countDocuments({ orgId: toObjectId(orgId), applianceId: appliance._id, enabled: true });
  const target = total ? Math.round(total * pct / 100) : null;
  const currentPct = total && used != null ? Math.round((used / total) * 1000) / 10 : null;
  return {
    scenario: { type: "NAS_CAPACITY_EXHAUSTED", subject: { type: "NAS_APPLIANCE", id: entityId, name: appliance.name }, parameters: { percent: pct } },
    currentState: { usedBytes: used, totalBytes: total, usedPercent: currentPct, measuredAt: stored?.checkedAt || null, measurement: total ? "MEASURED" : "UNKNOWN" },
    simulatedState: { usedPercent: pct, additionalBytesNeeded: target != null && used != null ? Math.max(0, target - used) : null },
    directImpact: {
      status: "IMPACT_DETECTED",
      affectedWorkloads: shares.map((s) => ({ share: s.shareName, quotaState: s.quota?.state || "NO_QUOTA", enforced: !!s.quota?.enforced })),
      policyTriggers: shares.filter((s) => s.quota?.hardBytes).map((s) => ({ share: s.shareName, warnAtPercent: s.quota.warnPercent ?? 80, criticalAtPercent: s.quota.criticalPercent ?? 95 })),
      tieringOptions: props.map((p) => ({ share: String(p.shareId), tier: p.tier, state: p.state, estimatedLocalSavingsBytes: p.estimatedLocalSavingsBytes, label: "DERIVED" })),
      backupImplications: [`${policies} enabled backup polic${policies === 1 ? "y" : "ies"}: backups read files but do not need local space`, `${snaps} snapshot(s) hold blocks of changed files; deleting or expiring old snapshots frees that space (immutable snapshots cannot be freed before their retention ends)`],
      recommendedActions: ["Apply approved COLD tiering proposals", "Expire unlocked old snapshots", "Grow the pool or add storage before reaching the hard quota", "Set share hard quotas so one share cannot consume the pool"],
    },
    unknowns: [unknown("GROWTH_RATE", "Growth over time is not tracked, so when the appliance would reach this level is unknown."), unknown("HEALTH_AT_FULL", "Filesystem behaviour at exhaustion depends on the real workload.")],
    resultStatus: total ? "COMPLETE" : "PARTIAL", disclaimer: DISCLAIMER, noChangesWereMade: true,
  };
}

export const NAS_SCENARIO_HANDLERS = {
  NAS_APPLIANCE_UNAVAILABLE: simulateApplianceUnavailable,
  NAS_DISK_FAILED: simulateDiskFailed,
  NAS_DATASET_ENCRYPTED: simulateDatasetEncrypted,
  NAS_USER_ACCESS_REVOKED: simulateUserAccessRevoked,
  NAS_CAPACITY_EXHAUSTED: simulateCapacityExhausted,
};
