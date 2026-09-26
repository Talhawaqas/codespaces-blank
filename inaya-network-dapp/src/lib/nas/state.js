// src/lib/nas/state.js
//
// Sovereign NAS SOW Workstream V (cryptographic proof of NAS state).
//
// Goal, in the SOW's words: let an auditor answer "is the reported NAS state
// the same state that Inaya recorded?". Not another audit chain: a state
// commitment is one hash over the NAS configuration and its protection
// policies, written through the existing evidence path (STATE_COMMITTED ->
// org audit chain). verifyNasState recomputes the state NOW and compares it
// to the last commitment, component by component, so drift (a share added, a
// policy changed, a quota edited) is reported precisely.
//
// Manifest hashes for snapshots, backups, replication and recovery already
// live on their records and in their evidence; verifyManifests re-derives
// them (a snapshot's manifest from the appliance, a backup recovery point's
// hash from its stored file list, optionally reading objects back) so a
// tampered manifest is caught.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canonicalHash } from "../documentAutomation/manifest.js";
import { fail, gate, loadAppliance, iso } from "./common.js";
import { recordNasEvidence } from "./evidence.js";
import { accessPolicyHash } from "./access.js";
import { manifestHashOf } from "./backup.js";
import { getTargetAdapter } from "./cloudTargets.js";

/** Pure: reduce each component to a comparable hash. */
export function stateComponentsFrom({ shares = [], policies = {}, applianceFingerprint = null }) {
  const shareComponents = {};
  for (const s of [...shares].sort((a, b) => a.shareName.localeCompare(b.shareName))) {
    shareComponents[s.shareName] = canonicalHash({
      backend: s.backend || "dir", access: accessPolicyHash(s), quota: s.quota ? { hard: s.quota.hardBytes, soft: s.quota.softBytes, enforced: s.quota.enforced } : null,
      worm: s.worm?.enabled ? { mode: s.worm.mode, days: s.worm.retentionDays } : null, nfs: s.protocols?.nfs?.enabled ? { clients: [...(s.protocols.nfs.clients || [])].sort(), ro: !!s.protocols.nfs.readOnly, squash: !!s.protocols.nfs.rootSquash } : null,
      threat: s.threatPolicy ? { enabled: s.threatPolicy.enabled, thresholds: s.threatPolicy.thresholds, lockdown: s.threatPolicy.autoLockdown } : null, tiering: s.tiering?.rules || null, recycle: s.recycle?.retentionDays || null,
    });
  }
  return { applianceFingerprint, shares: shareComponents, policies };
}

export async function computeNasState({ orgId, applianceId }) {
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const { appliance, agent } = res;
  const { nasShares, nasSnapshotPolicies, nasBackupPolicies, nasReplicationPolicies } = await getOrgCollections();
  const shares = await nasShares.find({ orgId: toObjectId(orgId), applianceId: appliance._id, deletedAt: null }).toArray();
  const ids = shares.map((s) => s._id);
  const [sp, bp, rp] = await Promise.all([
    nasSnapshotPolicies.find({ orgId: toObjectId(orgId), shareId: { $in: ids } }).toArray(),
    nasBackupPolicies.find({ orgId: toObjectId(orgId), shareId: { $in: ids } }).toArray(),
    nasReplicationPolicies.find({ orgId: toObjectId(orgId), shareId: { $in: ids } }).toArray(),
  ]);
  const fp = await agent.call("config_fingerprint", {}).catch(() => null);
  const byName = (rows, pick) => Object.fromEntries(rows.map((r) => [String(r.shareId), canonicalHash(pick(r))]));
  const components = stateComponentsFrom({
    shares,
    applianceFingerprint: fp?.fingerprint || null,
    policies: {
      snapshot: byName(sp, (r) => ({ i: r.intervalMinutes, k: r.keepLast, m: r.immutable, d: r.retentionDays, e: r.enabled })),
      backup: byName(bp, (r) => ({ i: r.intervalMinutes, inc: r.includePaths, exc: r.excludePatterns, t: r.targetIds, v: r.verify, e: r.enabled })),
      replication: byName(rp, (r) => ({ m: r.mode, i: r.intervalMinutes, t: String(r.targetApplianceId || r.targetId || ""), e: r.enabled })),
    },
  });
  return { components, stateHash: canonicalHash(components), shareCount: shares.length };
}

export async function commitNasState({ orgId, applianceId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const state = await computeNasState({ orgId, applianceId });
  if (state.error) return state;
  const { nasStateCommitments } = await getOrgCollections();
  const doc = { orgId: toObjectId(orgId), applianceId: toObjectId(applianceId), stateHash: state.stateHash, components: state.components, shareCount: state.shareCount, committedBy: actorEmail, createdAt: iso() };
  const r = await nasStateCommitments.insertOne(doc);
  const ev = await recordNasEvidence({ orgId, applianceId, subjectType: "NAS_APPLIANCE", subjectId: applianceId, action: "STATE_COMMITTED", actorEmail, integrityHash: state.stateHash, data: { commitmentId: String(r.insertedId), shareCount: state.shareCount }, graph: false });
  return { commitment: { ...doc, _id: r.insertedId }, evidence: ev.ok ? { id: ev.evidenceId, auditRef: ev.auditRef } : null };
}

function diff(a, b, path = "") {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = a?.[k]; const bv = b?.[k];
    if (av && bv && typeof av === "object" && typeof bv === "object") out.push(...diff(av, bv, `${path}${k}.`));
    else if (av !== bv) out.push({ component: `${path}${k}`, recorded: av ?? null, current: bv ?? null, change: av == null ? "ADDED" : bv == null ? "REMOVED" : "CHANGED" });
  }
  return out;
}

/** Recomputes the current state and compares it with the last commitment. */
export async function verifyNasState({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasStateCommitments, nasEvidence } = await getOrgCollections();
  const last = await nasStateCommitments.find({ orgId: toObjectId(orgId), applianceId: toObjectId(applianceId) }).sort({ createdAt: -1 }).limit(1).next();
  if (!last) return { committed: false, matches: null, note: "No state has been committed yet." };
  const now = await computeNasState({ orgId, applianceId });
  if (now.error) return now;
  // the commitment itself must also match what the audit chain recorded
  const ev = await nasEvidence.findOne({ orgId: toObjectId(orgId), applianceId: toObjectId(applianceId), action: "STATE_COMMITTED", integrityHash: last.stateHash });
  const recordedInAudit = !!ev;
  const differences = last.stateHash === now.stateHash ? [] : diff(last.components, now.components);
  return { committed: true, commitmentId: String(last._id), committedAt: last.createdAt, recordedHash: last.stateHash, currentHash: now.stateHash, matches: last.stateHash === now.stateHash, recordedInAuditChain: recordedInAudit, differences };
}

/** Re-derives manifest hashes so a tampered manifest is detected. */
export async function verifyManifests({ orgId, shareId, deep = false, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasBackupRuns, nasSnapshots, nasShares } = await getOrgCollections();
  const share = await nasShares.findOne({ _id: toObjectId(shareId), orgId: toObjectId(orgId), deletedAt: null });
  if (!share) return fail("Share not found.", 404);
  const res = await loadAppliance({ orgId, applianceId: share.applianceId });
  if (res.error) return res;
  const problems = [];
  const runs = await nasBackupRuns.find({ orgId: toObjectId(orgId), shareId: share._id, recoveryPoint: { $ne: null } }).sort({ startedAt: -1 }).limit(5).toArray();
  for (const r of runs) {
    const files = r.recoveryPoint.files || [];
    if (manifestHashOf(files) !== r.recoveryPoint.manifestHash) { problems.push({ kind: "BACKUP_MANIFEST_TAMPERED", runId: String(r._id) }); continue; }
    if (deep) {
      try {
        const adapter = await getTargetAdapter({ orgId, appliance: res.appliance, targetId: r.targetKey, actorEmail: "system" });
        for (const f of files.slice(0, 3)) {
          const buf = await adapter.get({ key: f.objectKey, versionId: f.versionId });
          if (!buf || createHash("sha256").update(buf).digest("hex") !== f.sha256) problems.push({ kind: "BACKUP_OBJECT_MISMATCH", runId: String(r._id), relativePath: f.relativePath });
        }
      } catch (e) { problems.push({ kind: "BACKUP_TARGET_UNREADABLE", runId: String(r._id), error: e.message }); }
    }
  }
  const snaps = await nasSnapshots.find({ orgId: toObjectId(orgId), shareId: share._id, state: "AVAILABLE" }).sort({ createdAt: -1 }).limit(3).toArray();
  for (const s of snaps) {
    try {
      const m = await res.agent.call("manifest", { share: share.shareName, snapshot: s.name }, { timeout: 300000 });
      if (m.manifestHash !== s.manifestHash) problems.push({ kind: "SNAPSHOT_MANIFEST_MISMATCH", snapshot: s.name });
    } catch (e) { problems.push({ kind: "SNAPSHOT_UNREADABLE", snapshot: s.name, error: e.message }); }
  }
  return { verified: problems.length === 0, backupRunsChecked: runs.length, snapshotsChecked: snaps.length, problems };
}
