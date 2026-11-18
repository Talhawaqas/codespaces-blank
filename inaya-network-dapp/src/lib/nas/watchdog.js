// src/lib/nas/watchdog.js
//
// Hosted "is the NAS worker still running?" check. Scheduled snapshots, off-site backups and ransomware scans run in
// scripts/nas-worker.mjs on the customer's host (runner.js); the website cannot reach the appliance, so /api/cron/nas
// is deliberately not a Vercel cron. If that worker stops entirely, nothing else notices: jobs.js only recovers jobs
// whose worker died mid-run, and replicationHealth marks DEGRADED without telling anyone.
//
// This check needs the database only. It finds ENABLED snapshot/backup policies whose last successful run is older
// than 2x their interval plus a grace period, groups them per appliance, and notifies the company's Owners and Admins
// (in-app + email, through notify/router.js) at most once per UTC day per appliance.
//
//   "last success"  snapshot policy: policy.lastRunAt (runSnapshotPolicy sets it only after the snapshot was made).
//                   backup policy:   newest nasBackupRuns row for the share with status COMPLETED or
//                                    COMPLETED_WITH_ERRORS (the run landed; per-file failures are reported elsewhere).
//   clock start     a policy that has never succeeded, or was edited/re-enabled since, is measured from its
//                   updatedAt (setSnapshotPolicy/setBackupPolicy refresh it), so a new policy gets a full window.
//   dedupe          no new collection (Atlas limit): the claimed day is stored on the appliance document,
//                   nasAppliances.scheduleWatchdog.alertDay, claimed atomically before sending so overlapping
//                   cron runs cannot double-notify. A send that throws releases the claim so the next run retries.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { notifyEvent } from "../notify/router.js";

export const STALE_GRACE_MINUTES = 60;
export const BACKUP_SUCCESS_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERRORS"];
const NAS_LINK = "/business?view=nas";
const MAX_LISTED = 5;

const ms = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/** Pure: the age after which a policy counts as stale. */
export function staleAfterMs(intervalMinutes, graceMinutes = STALE_GRACE_MINUTES) {
  return (2 * Number(intervalMinutes) + graceMinutes) * 60000;
}

/** Pure: is one policy overdue? Returns null when healthy, else { lastSuccessAt, overdueSinceMs }. */
export function evaluatePolicy({ intervalMinutes, lastSuccessAt, updatedAt, createdAt }, now, graceMinutes = STALE_GRACE_MINUTES) {
  if (!Number.isFinite(Number(intervalMinutes)) || Number(intervalMinutes) <= 0) return null;
  const success = ms(lastSuccessAt);
  const start = Math.max(success ?? 0, ms(updatedAt) ?? 0, ms(createdAt) ?? 0);
  if (!start) return null; // no reference point at all: nothing to measure against
  const age = now - start;
  return age > staleAfterMs(intervalMinutes, graceMinutes) ? { lastSuccessAt: success ? new Date(success).toISOString() : null, ageMs: age } : null;
}

function describe(item) {
  const what = item.kind === "snapshot" ? "Snapshots" : "Off-site backups";
  const last = item.lastSuccessAt ? `last succeeded ${item.lastSuccessAt.slice(0, 16).replace("T", " ")} UTC` : "have not succeeded since the schedule was set";
  return `${what} of "${item.shareName}" (every ${item.intervalMinutes} min) ${last}.`;
}

/**
 * One hosted pass. Options exist for tests: `now` (ms), `orgIds` (scope), `sender` (fake email), `graceMinutes`.
 * Returns { checked, stale, appliancesAlerted, skippedAlreadyAlerted, alerts: [{ orgId, applianceId, items }] }.
 */
export async function checkStaleNasSchedules({ now = Date.now(), orgIds, sender, graceMinutes = STALE_GRACE_MINUTES } = {}) {
  const { nasSnapshotPolicies, nasBackupPolicies, nasBackupRuns, nasShares, nasAppliances } = await getOrgCollections();
  const scope = orgIds ? { orgId: { $in: orgIds.map((id) => toObjectId(id)) } } : {};
  const [snapPolicies, backupPolicies] = await Promise.all([
    nasSnapshotPolicies.find({ ...scope, enabled: true }).toArray(),
    nasBackupPolicies.find({ ...scope, enabled: true }).toArray(),
  ]);
  const shareIds = [...new Set([...snapPolicies, ...backupPolicies].map((p) => String(p.shareId)))].map((id) => toObjectId(id));
  if (!shareIds.length) return { checked: 0, stale: 0, appliancesAlerted: 0, skippedAlreadyAlerted: 0, alerts: [] };

  const shares = new Map((await nasShares.find({ _id: { $in: shareIds }, deletedAt: null }, { projection: { shareName: 1, applianceId: 1 } }).toArray()).map((s) => [String(s._id), s]));
  const lastBackups = new Map((await nasBackupRuns.aggregate([
    { $match: { shareId: { $in: shareIds }, status: { $in: BACKUP_SUCCESS_STATUSES } } },
    { $group: { _id: "$shareId", last: { $max: { $ifNull: ["$completedAt", "$startedAt"] } } } },
  ]).toArray()).map((r) => [String(r._id), r.last]));

  const byAppliance = new Map();
  let checked = 0;
  const consider = (kind, p, lastSuccessAt) => {
    const share = shares.get(String(p.shareId));
    if (!share) return; // share deleted: its policy no longer runs
    checked++;
    const verdict = evaluatePolicy({ intervalMinutes: p.intervalMinutes, lastSuccessAt, updatedAt: p.updatedAt, createdAt: p.createdAt }, now, graceMinutes);
    if (!verdict) return;
    const applianceId = String(p.applianceId || share.applianceId);
    if (!byAppliance.has(applianceId)) byAppliance.set(applianceId, { orgId: String(p.orgId), applianceId, items: [] });
    byAppliance.get(applianceId).items.push({ kind, shareId: String(p.shareId), shareName: share.shareName, intervalMinutes: p.intervalMinutes, lastSuccessAt: verdict.lastSuccessAt });
  };
  for (const p of snapPolicies) consider("snapshot", p, p.lastRunAt);
  for (const p of backupPolicies) consider("backup", p, lastBackups.get(String(p.shareId)));

  const day = dayOf(now);
  const alerts = [];
  let skippedAlreadyAlerted = 0;
  let stale = 0;
  for (const group of byAppliance.values()) {
    stale += group.items.length;
    const filter = { _id: toObjectId(group.applianceId), orgId: toObjectId(group.orgId), deletedAt: null, "scheduleWatchdog.alertDay": { $ne: day } };
    const appliance = await nasAppliances.findOneAndUpdate(filter, { $set: { scheduleWatchdog: { alertDay: day, alertedAt: new Date(now).toISOString(), staleCount: group.items.length, items: group.items.slice(0, 20) } } }, { projection: { name: 1 }, returnDocument: "after" });
    if (!appliance) {
      // Either already alerted today, or the appliance was deleted (its policies then no longer matter).
      if (await nasAppliances.countDocuments({ _id: toObjectId(group.applianceId), deletedAt: null }, { limit: 1 })) skippedAlreadyAlerted++;
      continue;
    }
    const name = appliance.name || "NAS appliance";
    const lines = group.items.slice(0, MAX_LISTED).map(describe);
    if (group.items.length > MAX_LISTED) lines.push(`…and ${group.items.length - MAX_LISTED} more.`);
    try {
      await notifyEvent({
        orgId: group.orgId, event: "nas.schedule_stale", audience: "admins",
        title: `${name}: scheduled snapshots or backups have stopped running`,
        body: `${lines.join(" ")} The NAS worker on the appliance host may have stopped. Check that scripts/nas-worker.mjs is running.`,
        link: NAS_LINK, sourceId: group.applianceId,
        dedupeKey: `${group.orgId}:nas.schedule_stale:${group.applianceId}:${day}`,
        ...(sender ? { sender } : {}),
      });
      alerts.push(group);
    } catch (err) {
      console.error("nas watchdog notify failed (will retry next run):", err.message);
      await nasAppliances.updateOne({ _id: toObjectId(group.applianceId), "scheduleWatchdog.alertDay": day }, { $unset: { "scheduleWatchdog.alertDay": "" } });
    }
  }
  return { checked, stale, appliancesAlerted: alerts.length, skippedAlreadyAlerted, alerts };
}
