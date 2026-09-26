// src/lib/nas/replication.js
//
// Sovereign NAS SOW Workstream N (replication). The two modes are kept
// distinct, as the SOW requires:
//
//   nas-to-nas    NAS A -> NAS B. Real rsync with checksums and a manifest
//                 comparison of source vs replica. IMPORTANT LIMIT: this
//                 environment has one appliance host, so the "target
//                 appliance" is another appliance record served by the same
//                 host (transport "local-host"). Cross-host transport
//                 (rsync over SSH between two machines) is NOT implemented
//                 and therefore not claimed.
//   nas-to-inaya  NAS -> Inaya sovereign storage. This is the backup engine
//                 (backup.js); a replication policy of this mode simply
//                 schedules it, so there is no second upload protocol.
//
// Both modes are jobs: idempotent per schedule bucket, resumable (rsync
// --partial), retried with backoff, audited, and reported with a health state
// (a replica older than twice its interval is DEGRADED).
//
// Cross-organization replication is impossible by construction: the target
// appliance is resolved with the SAME orgId as the source, so another
// organization's appliance is "not found" (tested).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, gate, loadShare, loadAppliance, iso, notifyNasManagers } from "./common.js";
import { recordNasEvidence } from "./evidence.js";
import { registerJobHandler, enqueueJob, runJob } from "./jobs.js";
import { runBackup } from "./backup.js";

export const REPLICATION_MODES = ["nas-to-nas", "nas-to-inaya"];

function replicaName(policy) {
  return `r${String(policy._id).slice(-12)}`;
}

export async function createReplicationPolicy({ orgId, shareId, mode, targetApplianceId, targetId, intervalMinutes = 60, verify = true, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!REPLICATION_MODES.includes(mode)) return fail("mode must be nas-to-nas or nas-to-inaya.");
  const im = Number(intervalMinutes);
  if (!Number.isFinite(im) || im < 1 || im > 525600) return fail("intervalMinutes must be 1-525600.");
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share } = res;
  const doc = { orgId: toObjectId(orgId), shareId: share._id, applianceId: share.applianceId, mode, intervalMinutes: im, verify: !!verify, enabled: true, state: "QUEUED", lastSuccessAt: null, lastFailureAt: null, lastError: null, transport: null, createdBy: actorEmail, createdAt: iso(), nextRunAt: iso() };
  if (mode === "nas-to-nas") {
    const target = await loadAppliance({ orgId, applianceId: targetApplianceId });
    if (target.error) return fail("The target appliance was not found in this organization.", 404);
    doc.targetApplianceId = target.appliance._id;
    doc.transport = "local-host";
    doc.transportNote = "Replica is stored on the target appliance's host. Cross-host transport is not implemented.";
  } else {
    doc.targetId = targetId || "inaya";
  }
  const { nasReplicationPolicies } = await getOrgCollections();
  const r = await nasReplicationPolicies.insertOne(doc);
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "POLICY_CHANGED", actorEmail, policy: { kind: "replication", mode, intervalMinutes: im, targetApplianceId: doc.targetApplianceId ? String(doc.targetApplianceId) : null }, data: { change: "replication-policy" }, graph: false });
  return { policy: { ...doc, _id: r.insertedId } };
}

export async function listReplicationPolicies({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasReplicationPolicies } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (shareId) q.shareId = toObjectId(shareId);
  const policies = await nasReplicationPolicies.find(q).sort({ createdAt: -1 }).toArray();
  return { policies: policies.map((p) => ({ ...p, health: replicationHealth(p) })) };
}

/** Pure. */
export function replicationHealth(p, now = Date.now()) {
  if (!p.enabled) return "DISABLED";
  if (p.state === "RUNNING") return "RUNNING";
  if (!p.lastSuccessAt) return p.lastFailureAt ? "FAILED" : "PENDING";
  const age = now - new Date(p.lastSuccessAt).getTime();
  if (p.lastFailureAt && new Date(p.lastFailureAt) > new Date(p.lastSuccessAt)) return "FAILED";
  return age > p.intervalMinutes * 2 * 60000 ? "DEGRADED" : "HEALTHY";
}

export async function runReplication({ orgId, policyId, actorEmail = "system", actorType = "system", beat }) {
  const { nasReplicationPolicies } = await getOrgCollections();
  const policy = await nasReplicationPolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId) });
  if (!policy) return fail("Replication policy not found.", 404);
  const res = await loadShare({ orgId, shareId: policy.shareId });
  if (res.error) return res;
  const { share, agent } = res;
  await nasReplicationPolicies.updateOne({ _id: policy._id }, { $set: { state: "RUNNING", lastStartedAt: iso() } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "REPLICATION_STARTED", actorEmail, actorType, data: { policyId: String(policy._id), mode: policy.mode }, graph: false });
  try {
    let out;
    if (policy.mode === "nas-to-nas") {
      const target = await loadAppliance({ orgId, applianceId: policy.targetApplianceId });
      if (target.error) throw new Error("The target appliance is no longer available in this organization.");
      out = await target.agent.call("replicate", { share: share.shareName, targetName: replicaName(policy), verify: policy.verify, delete: true }, { timeout: 1200000 });
      if (policy.verify && !out.verified) throw new Error("The replica does not match the source (manifest hash differs).");
      if (beat) await beat({ verified: out.verified });
    } else {
      const b = await runBackup({ orgId, shareId: share._id, targetId: policy.targetId || "inaya", verify: "sample", actorEmail, actorType });
      if (b.error) throw new Error(b.error);
      if (b.status !== "COMPLETED") throw new Error(`Backup finished as ${b.status}.`);
      out = { verified: true, backupRunId: String(b.runId), filesBackedUp: b.filesBackedUp, filesSkipped: b.filesSkipped, sourceManifestHash: b.recoveryManifestHash, targetManifestHash: b.recoveryManifestHash };
    }
    await nasReplicationPolicies.updateOne({ _id: policy._id }, { $set: { state: "IDLE", lastSuccessAt: iso(), lastError: null, lastResult: { bytesTransferred: out.bytesTransferred ?? null, filesTransferred: out.filesTransferred ?? out.filesBackedUp ?? null, fileCount: out.fileCount ?? null, manifestHash: out.targetManifestHash || null, verified: !!out.verified }, nextRunAt: new Date(Date.now() + policy.intervalMinutes * 60000).toISOString() } });
    await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "REPLICATION_COMPLETED", actorEmail, actorType, integrityHash: out.targetManifestHash || null, data: { policyId: String(policy._id), mode: policy.mode, verified: !!out.verified, bytes: out.bytesTransferred ?? null } });
    return { ok: true, ...out };
  } catch (err) {
    await nasReplicationPolicies.updateOne({ _id: policy._id }, { $set: { state: "FAILED", lastFailureAt: iso(), lastError: String(err.message).slice(0, 300) } });
    await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "REPLICATION_FAILED", actorEmail, actorType, result: "FAILED", data: { policyId: String(policy._id), reason: String(err.message).slice(0, 200) } });
    await notifyNasManagers({ orgId, type: "nas_replication_failed", title: `Replication of ${share.shareName} failed`, body: String(err.message).slice(0, 200), dedupeKey: `${policy._id}:${Math.floor(Date.now() / 3600000)}:repl-failed`, sourceId: share._id });
    throw err;
  }
}

export async function replicateNow({ orgId, policyId, idempotencyKey, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasReplicationPolicies } = await getOrgCollections();
  const policy = await nasReplicationPolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId) });
  if (!policy) return fail("Replication policy not found.", 404);
  const { job } = await enqueueJob({ orgId, applianceId: policy.applianceId, shareId: policy.shareId, kind: "replicate", payload: { policyId: String(policy._id), actorEmail }, idempotencyKey: idempotencyKey || `replicate:${policy._id}:${Date.now()}`, actorEmail });
  const out = await runJob({ jobId: job._id });
  return out.ran ? { jobId: job._id, ...out } : { jobId: job._id, ...out, error: out.reason, status: 409 };
}

registerJobHandler("replicate", async (job) => {
  const r = await runReplication({ orgId: job.orgId, policyId: job.payload.policyId, actorEmail: job.payload.actorEmail || "system", actorType: job.payload.actorEmail ? "human" : "system" });
  return { result: r };
});

export async function enqueueDueReplication({ orgId } = {}) {
  const { nasReplicationPolicies } = await getOrgCollections();
  const q = { enabled: true, state: { $ne: "RUNNING" }, nextRunAt: { $lte: iso() } };
  if (orgId) q.orgId = toObjectId(orgId);
  let queued = 0;
  for (const p of await nasReplicationPolicies.find(q).toArray()) {
    const bucket = Math.floor(Date.now() / (p.intervalMinutes * 60000));
    const r = await enqueueJob({ orgId: p.orgId, applianceId: p.applianceId, shareId: p.shareId, kind: "replicate", payload: { policyId: String(p._id) }, idempotencyKey: `replicate:${p._id}:${bucket}` });
    if (r.created) queued++;
  }
  return { queued };
}

/** Verifies a replica against the source right now (no data movement). */
export async function verifyReplica({ orgId, policyId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasReplicationPolicies } = await getOrgCollections();
  const policy = await nasReplicationPolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId), mode: "nas-to-nas" });
  if (!policy) return fail("Replication policy not found.", 404);
  const res = await loadShare({ orgId, shareId: policy.shareId });
  if (res.error) return res;
  const target = await loadAppliance({ orgId, applianceId: policy.targetApplianceId });
  if (target.error) return target;
  const [src, rep] = await Promise.all([res.agent.call("manifest", { share: res.share.shareName }, { timeout: 600000 }), target.agent.call("replica_manifest", { targetName: replicaName(policy) })]);
  return { matches: src.manifestHash === rep.manifestHash, sourceManifestHash: src.manifestHash, replicaManifestHash: rep.manifestHash, fileCount: src.fileCount };
}

/**
 * Failover: serve the replica as a normal share on the target appliance.
 * mode "test" serves it READ-ONLY (a test failover that cannot diverge the
 * replica); mode "promote" makes it writable. Promotion is recorded, and the
 * caller is told the source must be re-protected by reversing the policy.
 */
export async function failoverReplica({ orgId, policyId, mode = "test", shareName, ownerUnixUser, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!["test", "promote"].includes(mode)) return fail("mode must be test or promote.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(shareName || "")) return fail("A valid failover share name is required.");
  const { nasReplicationPolicies, nasShares } = await getOrgCollections();
  const policy = await nasReplicationPolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId), mode: "nas-to-nas" });
  if (!policy) return fail("Replication policy not found.", 404);
  const target = await loadAppliance({ orgId, applianceId: policy.targetApplianceId });
  if (target.error) return target;
  let out;
  try {
    out = await target.agent.call("replica_promote", { targetName: replicaName(policy), shareName, owner: ownerUnixUser, readOnly: mode === "test" });
  } catch (err) {
    return fail(`Failover share not created: ${err.message}`, err.code === "EXISTS" ? 409 : 502);
  }
  const now = iso();
  const doc = { orgId: toObjectId(orgId), applianceId: target.appliance._id, shareName, ownerUnixUser, dataPath: out.dataPath, backend: "dir", poolId: null, poolName: null, quota: null, protocol: "smb", protocols: { smb: true, nfs: { enabled: false } }, access: { entries: [], hostsAllow: [], readOnly: mode === "test", hidden: false, enabled: true, lockdown: { active: false } }, recycle: { enabled: true, retentionDays: 30 }, worm: { enabled: false }, failoverOf: policy.shareId, status: "ACTIVE", createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null };
  const r = await nasShares.insertOne(doc);
  await recordNasEvidence({ orgId, applianceId: target.appliance._id, subjectId: r.insertedId, action: "FAILOVER_PROMOTED", actorEmail, newState: mode === "test" ? "TEST_FAILOVER_READ_ONLY" : "PROMOTED_WRITABLE", data: { policyId: String(policy._id), sourceShareId: String(policy.shareId), mode } });
  return { share: { ...doc, _id: r.insertedId }, mode, reProtection: mode === "promote" ? "The original share is no longer the primary. Create a replication policy from the promoted share back to protect it." : null };
}

export async function deleteReplicationPolicy({ orgId, policyId, purgeReplica = false, membership }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasReplicationPolicies } = await getOrgCollections();
  const policy = await nasReplicationPolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId) });
  if (!policy) return fail("Replication policy not found.", 404);
  if (purgeReplica && policy.mode === "nas-to-nas") {
    const target = await loadAppliance({ orgId, applianceId: policy.targetApplianceId });
    if (!target.error) await target.agent.call("replica_delete", { targetName: replicaName(policy) }).catch(() => {});
  }
  await nasReplicationPolicies.deleteOne({ _id: policy._id });
  return { deleted: true };
}
