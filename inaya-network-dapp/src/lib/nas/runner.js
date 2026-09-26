// src/lib/nas/runner.js
//
// The NAS background worker (SOW 39): one pass turns every due schedule into
// idempotent jobs and runs them. Safe to call repeatedly and from several
// processes: job keys are bucketed per schedule interval (unique index), and a
// job is claimed atomically, so an overlapping run cannot duplicate a backup,
// a replication, a snapshot or an alert.
//
// WHERE it runs matters: it needs to reach the appliance, so it runs on the
// host that can run the appliance agent (the appliance host / a machine with
// wsl.exe access) -- see scripts/nas-worker.mjs and /api/cron/nas. It is NOT in
// vercel.json: the hosted website cannot reach a NAS behind a customer's
// router, and pretending otherwise would fail silently.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { enqueueJob, processDueJobs } from "./jobs.js";
import { enqueueDueSnapshotWork, releaseExpiredLocks } from "./snapshots.js";
import { enqueueDueScans, liftExpiredLockdowns } from "./ransomware.js";
import { enqueueDueReplication } from "./replication.js";
import { reconcileNasAccess } from "./access.js";
import { getShareCapacity } from "./quotas.js";
import { SYNTHETIC_OWNER, iso } from "./common.js";
import "./backup.js"; // registers the backup job handler

async function enqueueDueBackups(orgId) {
  const { nasBackupPolicies } = await getOrgCollections();
  const q = { enabled: true, nextRunAt: { $lte: iso() } };
  if (orgId) q.orgId = toObjectId(orgId);
  let queued = 0;
  for (const p of await nasBackupPolicies.find(q).toArray()) {
    const bucket = Math.floor(Date.now() / (p.intervalMinutes * 60000));
    for (const targetId of p.targetIds || ["inaya"]) {
      const r = await enqueueJob({ orgId: p.orgId, applianceId: p.applianceId, shareId: p.shareId, kind: "backup", payload: { targetId, verify: p.verify || "sample" }, idempotencyKey: `backup:${p.shareId}:${targetId}:${bucket}`, maxAttempts: 4 });
      if (r.created) queued++;
    }
    await nasBackupPolicies.updateOne({ _id: p._id }, { $set: { nextRunAt: new Date(Date.now() + p.intervalMinutes * 60000).toISOString() } });
  }
  return { queued };
}

async function purgeRecycleBins(orgId) {
  const { nasShares } = await getOrgCollections();
  const q = { deletedAt: null, "recycle.enabled": { $ne: false } };
  if (orgId) q.orgId = toObjectId(orgId);
  const { NasAgentClient } = await import("./agent.js");
  const { nasAppliances } = await getOrgCollections();
  let removed = 0;
  const day = Math.floor(Date.now() / 86400000);
  for (const s of await nasShares.find(q).toArray()) {
    if (s.recycleLastPurgeDay === day) continue;
    const a = await nasAppliances.findOne({ _id: s.applianceId, deletedAt: null });
    if (!a) continue;
    try {
      const r = await new NasAgentClient({ backend: a.backend }).call("recycle_purge", { share: s.shareName, olderThanDays: s.recycle?.retentionDays || 30 });
      removed += r.removed;
      await nasShares.updateOne({ _id: s._id }, { $set: { recycleLastPurgeDay: day } });
    } catch { /* an unreachable appliance is reported by its health state */ }
  }
  return { removed };
}

/** One worker pass. Every step is isolated: a failure in one never blocks the rest. */
export async function runNasWorker({ orgId, budgetMs = 240000 } = {}) {
  const started = Date.now();
  const step = async (name, fn) => { try { return await fn(); } catch (e) { console.error(`nas worker step "${name}" failed:`, e.message); return { error: e.message }; } };
  const report = {};
  report.scheduling = {
    snapshots: await step("snapshots", () => enqueueDueSnapshotWork({ orgId })),
    scans: await step("scans", () => enqueueDueScans({ orgId })),
    replication: await step("replication", () => enqueueDueReplication({ orgId })),
    backups: await step("backups", () => enqueueDueBackups(orgId)),
  };
  report.maintenance = {
    releasedLocks: await step("release-locks", () => releaseExpiredLocks({ orgId })),
    liftedLockdowns: await step("lockdowns", () => liftExpiredLockdowns({ orgId })),
    recycle: await step("recycle", () => purgeRecycleBins(orgId)),
  };
  if (orgId) report.access = await step("reconcile", () => reconcileNasAccess({ orgId }));
  else {
    const { orgs } = await getOrgCollections();
    const all = await orgs.find({}, { projection: { _id: 1 } }).toArray();
    report.access = [];
    for (const o of all) report.access.push(await step("reconcile", () => reconcileNasAccess({ orgId: o._id })));
  }
  const { nasShares } = await getOrgCollections();
  const quotaQ = { deletedAt: null, "quota.hardBytes": { $ne: null } };
  if (orgId) quotaQ.orgId = toObjectId(orgId);
  report.quota = [];
  for (const s of await nasShares.find(quotaQ).toArray()) report.quota.push(await step("quota", () => getShareCapacity({ orgId: s.orgId, shareId: s._id, membership: SYNTHETIC_OWNER }).then((r) => ({ share: s.shareName, state: r.state }))));
  report.jobs = await step("jobs", () => processDueJobs({ orgId, budgetMs: Math.max(5000, budgetMs - (Date.now() - started)) }));
  report.elapsedMs = Date.now() - started;
  return report;
}
