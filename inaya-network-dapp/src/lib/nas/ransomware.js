// src/lib/nas/ransomware.js
//
// Sovereign NAS SOW Workstream L: ransomware / threat-aware protection.
//
//   DETECT -> CLASSIFY -> PROTECT -> SNAPSHOT / IMMUTABLE COPY -> ALERT
//          -> OPTIONAL SHARE LOCKDOWN -> EVIDENCE -> RECOVERY / HUMAN DECISION
//
// Signals are MEASURED on the appliance, not guessed:
//   - files modified / deleted / added versus a stored baseline of the share;
//   - encryption-like rewrites: a modified file whose first-32KB Shannon
//     entropy jumped to >= 7.5 bits/byte (and rose >= 1.0) -- ordinary
//     compressed formats were already high and are not counted;
//   - extension changes (`report.docx` -> `report.docx.locked`, known
//     ransomware extensions) and ransom-note file names;
//   - repeated failed SMB logons (parsed from the Samba logs);
//   - snapshot-deletion attempts and permission-change bursts recorded by this
//     control plane.
//
// Bounded automation (SOW 19): the default response is protective and
// reversible -- an immutable snapshot and an alert. A share lockdown (read-only
// + connections closed) is only automatic if the policy explicitly enables it
// AND the level is CRITICAL AND the share is not exempted; it always expires
// (lockdownMinutes) and is otherwise a RECOMMENDATION that a human approves.
// Nothing here deletes or encrypts data.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, gate, loadShare, iso, notifyNasManagers, daysFromNow } from "./common.js";
import { recordNasEvidence } from "./evidence.js";
import { applyShareAccess } from "./access.js";
import { registerJobHandler, enqueueJob } from "./jobs.js";

export const THREAT_LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const DEFAULT_THRESHOLDS = { modifyRatio: 0.3, deleteRatio: 0.2, minChangedFiles: 5, extensionChanges: 5, highEntropyRewrites: 5, failedLogons: 10, permissionChanges: 3 };
const PROTECT_RETENTION_DAYS = 30;

/** Pure: turn measured signals into a level, a score and the reasons. */
export function classifyThreat(signals, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const reasons = [];
  let score = 0;
  const base = Math.max(signals.baselineFiles || 0, 1);
  const modifyRatio = (signals.modified || 0) / base;
  const deleteRatio = (signals.deleted || 0) / base;
  if ((signals.ransomNotes || 0) > 0) { score += 50; reasons.push(`${signals.ransomNotes} ransom-note style file(s) appeared`); }
  if ((signals.extensionChanges || 0) >= t.extensionChanges) { score += 40; reasons.push(`${signals.extensionChanges} files gained a suspicious or changed extension`); }
  if ((signals.highEntropyRewrites || 0) >= t.highEntropyRewrites) { score += 40; reasons.push(`${signals.highEntropyRewrites} files were rewritten with encryption-like content`); }
  if ((signals.modified || 0) >= t.minChangedFiles && modifyRatio >= t.modifyRatio) { score += 20; reasons.push(`${Math.round(modifyRatio * 100)}% of files changed`); }
  if ((signals.deleted || 0) >= t.minChangedFiles && deleteRatio >= t.deleteRatio) { score += 25; reasons.push(`${Math.round(deleteRatio * 100)}% of files were deleted`); }
  if ((signals.failedLogons || 0) >= t.failedLogons) { score += 15; reasons.push(`${signals.failedLogons} failed logons in the window`); }
  if ((signals.snapshotDeleteAttempts || 0) > 0) { score += 30; reasons.push(`${signals.snapshotDeleteAttempts} attempt(s) to delete a protected snapshot`); }
  if ((signals.permissionChanges || 0) >= t.permissionChanges) { score += 15; reasons.push(`${signals.permissionChanges} permission changes in an hour`); }
  const level = score >= 80 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : score > 0 ? "LOW" : "NONE";
  return { level, score, reasons };
}

export async function setThreatPolicy({ orgId, shareId, enabled = true, thresholds = {}, autoSnapshot = true, autoLockdown = false, lockdownMinutes = 60, scanIntervalMinutes = 15, exempt = false, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  if (!(lockdownMinutes >= 1 && lockdownMinutes <= 1440)) return fail("lockdownMinutes must be 1-1440.");
  if (!(scanIntervalMinutes >= 1 && scanIntervalMinutes <= 1440)) return fail("scanIntervalMinutes must be 1-1440.");
  const clean = {};
  for (const [k, v] of Object.entries(thresholds || {})) if (k in DEFAULT_THRESHOLDS && Number.isFinite(Number(v)) && Number(v) >= 0) clean[k] = Number(v);
  const threatPolicy = { enabled: !!enabled, thresholds: clean, autoSnapshot: !!autoSnapshot, autoLockdown: !!autoLockdown, lockdownMinutes, scanIntervalMinutes, exempt: !!exempt, nextScanAt: iso(), updatedAt: iso() };
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: res.share._id }, { $set: { threatPolicy } });
  await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "POLICY_CHANGED", actorEmail, policy: { kind: "threat", ...threatPolicy }, data: { change: "threat-policy" }, graph: false });
  return { threatPolicy };
}

export async function setBaseline({ orgId, shareId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const r = await res.agent.call("scan_baseline", { share: res.share.shareName }, { timeout: 300000 });
  return { baseline: r };
}

async function recentCount(orgId, subjectId, action, minutes) {
  const { nasEvidence } = await getOrgCollections();
  return nasEvidence.countDocuments({ orgId: toObjectId(orgId), subjectId: toObjectId(subjectId), action, createdAt: { $gte: new Date(Date.now() - minutes * 60000).toISOString() } });
}

/** Locks a share to read-only and closes its connections; reversible. */
export async function setLockdown({ orgId, shareId, active, reason, expiresAt, actorEmail = "system", actorType = "system" }) {
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  const lockdown = active ? { active: true, since: iso(), reason: reason || "Threat protection", expiresAt: expiresAt || null } : { active: false };
  const access = { ...(share.access || {}), lockdown };
  try {
    await applyShareAccess({ orgId, share: { ...share, access }, agent });
    if (active) await agent.call("share_close_connections", { share: share.shareName }).catch(() => {});
  } catch (err) {
    return fail(`Lockdown could not be applied on the appliance: ${err.message}`, 502);
  }
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: share._id }, { $set: { access, updatedAt: iso() } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: active ? "SHARE_LOCKDOWN" : "SHARE_LOCKDOWN_LIFTED", actorEmail, actorType, newState: active ? "READ_ONLY" : "NORMAL", data: { reason: reason || null, expiresAt: lockdown.expiresAt || null } });
  return { lockdown };
}

/** The most recent snapshot taken before a given moment (a "last clean state"). */
export async function lastCleanSnapshot({ orgId, shareId, before }) {
  const { nasSnapshots } = await getOrgCollections();
  return nasSnapshots.find({ orgId: toObjectId(orgId), shareId: toObjectId(shareId), state: "AVAILABLE", source: { $ne: "threat" }, createdAt: { $lt: before || iso() } }).sort({ createdAt: -1 }).limit(1).next();
}

/**
 * Scans one share and, when warranted, responds. Safe to call repeatedly:
 * an open event of the same or higher level within 30 minutes is updated, not
 * duplicated, and notifications dedupe on the event.
 */
export async function scanShare({ orgId, shareId, respond = true, actorEmail = "system", actorType = "system" }) {
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  const policy = share.threatPolicy || { enabled: true, thresholds: {}, autoSnapshot: true, autoLockdown: false, lockdownMinutes: 60 };
  const scan = await agent.call("scan", { share: share.shareName }, { timeout: 600000 });
  if (!scan.baseline) {
    await agent.call("scan_baseline", { share: share.shareName }, { timeout: 300000 });
    return { level: "NONE", baselineCreated: true };
  }
  const [auth, snapDeny, permChanges] = await Promise.all([
    agent.call("auth_failures", { sinceMinutes: 15 }).catch(() => ({ failedLogons: 0 })),
    recentCount(orgId, share._id, "SNAPSHOT_DELETE_DENIED", 60),
    recentCount(orgId, share._id, "SHARE_PERMISSION_CHANGED", 60),
  ]);
  const signals = { baselineFiles: scan.baselineFiles, scannedFiles: scan.scannedFiles, modified: scan.modified, deleted: scan.deleted, added: scan.added, extensionChanges: scan.extensionChanges, highEntropyRewrites: scan.highEntropyRewrites, ransomNotes: scan.ransomNotes, failedLogons: auth.failedLogons, snapshotDeleteAttempts: snapDeny, permissionChanges: permChanges };
  const cls = classifyThreat(signals, policy.thresholds);
  const out = { level: cls.level, score: cls.score, reasons: cls.reasons, signals, samples: scan.samples };
  const { nasThreatEvents, nasShares } = await getOrgCollections();

  if (cls.level === "NONE" || cls.level === "LOW") {
    // rolling baseline only while nothing suspicious is happening, so an
    // attack in progress is always measured against the last clean state
    if (scan.added || scan.modified || scan.deleted) await agent.call("scan_baseline", { share: share.shareName }, { timeout: 300000 }).catch(() => {});
    await nasShares.updateOne({ _id: share._id }, { $set: { "threatPolicy.lastScanAt": iso(), "threatPolicy.lastLevel": cls.level } });
    return out;
  }

  const existing = await nasThreatEvents.find({ orgId: toObjectId(orgId), shareId: share._id, state: "OPEN", detectedAt: { $gte: new Date(Date.now() - 30 * 60000).toISOString() } }).sort({ detectedAt: -1 }).limit(1).next();
  let event;
  if (existing && THREAT_LEVELS.indexOf(existing.level) >= THREAT_LEVELS.indexOf(cls.level)) {
    await nasThreatEvents.updateOne({ _id: existing._id }, { $set: { lastSeenAt: iso(), signals }, $inc: { scans: 1 } });
    event = existing;
    out.eventId = String(existing._id);
    out.duplicate = true;
  } else {
    const doc = { orgId: toObjectId(orgId), applianceId: share.applianceId, shareId: share._id, level: cls.level, score: cls.score, reasons: cls.reasons, signals, samples: scan.samples, state: "OPEN", detectedAt: iso(), lastSeenAt: iso(), scans: 1, protection: { snapshot: null, lockdown: { state: "NOT_REQUIRED" } }, resolvedAt: null };
    const ins = await nasThreatEvents.insertOne(doc);
    event = { ...doc, _id: ins.insertedId };
    out.eventId = String(event._id);
    await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "THREAT_DETECTED", actorEmail, actorType, result: cls.level, integrityHash: null, data: { eventId: String(event._id), level: cls.level, score: cls.score, reasons: cls.reasons } });
    await notifyNasManagers({ orgId, type: "nas_threat_detected", severity: cls.level === "MEDIUM" ? "warning" : "critical", title: `Possible ransomware activity on ${share.shareName} (${cls.level})`, body: cls.reasons.join("; "), dedupeKey: `${event._id}:threat`, sourceId: share._id });
  }

  if (respond && !policy.exempt && (cls.level === "HIGH" || cls.level === "CRITICAL") && !event.protection?.snapshot) {
    // PROTECT: an immutable snapshot of the CURRENT state (evidence) -- the
    // recovery path is the last clean snapshot from before detectedAt.
    if (policy.autoSnapshot !== false) {
      const { createSnapshotCore } = await import("./snapshots.js");
      const snap = await createSnapshotCore({ orgId, share, agent, immutable: true, retentionDays: PROTECT_RETENTION_DAYS, source: "threat", reason: `Protective snapshot for threat ${event._id}`, actorEmail, actorType });
      if (snap.snapshot) {
        await nasThreatEvents.updateOne({ _id: event._id }, { $set: { "protection.snapshot": { name: snap.snapshot.name, retentionUntil: snap.snapshot.retentionUntil, manifestHash: snap.snapshot.manifestHash } } });
        await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "PROTECTION_TRIGGERED", actorEmail, actorType, integrityHash: snap.snapshot.manifestHash, data: { eventId: String(event._id), action: "immutable-snapshot", snapshot: snap.snapshot.name } });
        out.protectiveSnapshot = snap.snapshot.name;
      }
    }
    // OPTIONAL LOCKDOWN: automatic only when explicitly enabled + CRITICAL
    if (cls.level === "CRITICAL") {
      if (policy.autoLockdown) {
        const l = await setLockdown({ orgId, shareId: share._id, active: true, reason: `Automatic lockdown for threat ${event._id}`, expiresAt: new Date(Date.now() + (policy.lockdownMinutes || 60) * 60000).toISOString(), actorEmail, actorType });
        if (!l.error) {
          await nasThreatEvents.updateOne({ _id: event._id }, { $set: { "protection.lockdown": { state: "ACTIVE", automatic: true, since: iso(), expiresAt: l.lockdown.expiresAt } } });
          await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "PROTECTION_TRIGGERED", actorEmail, actorType, data: { eventId: String(event._id), action: "lockdown", automatic: true, expiresAt: l.lockdown.expiresAt } });
          out.lockdown = "ACTIVE";
        }
      } else {
        await nasThreatEvents.updateOne({ _id: event._id }, { $set: { "protection.lockdown": { state: "RECOMMENDED" } } });
        out.lockdown = "RECOMMENDED";
      }
    }
  }
  await nasShares.updateOne({ _id: share._id }, { $set: { "threatPolicy.lastScanAt": iso(), "threatPolicy.lastLevel": cls.level } });
  return out;
}

/** Human approval of a recommended lockdown. */
export async function approveLockdown({ orgId, eventId, minutes = 60, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasThreatEvents } = await getOrgCollections();
  const ev = await nasThreatEvents.findOne({ _id: toObjectId(eventId), orgId: toObjectId(orgId) });
  if (!ev) return fail("Threat event not found.", 404);
  if (ev.protection?.lockdown?.state === "ACTIVE") return fail("The share is already locked down.", 409);
  const l = await setLockdown({ orgId, shareId: ev.shareId, active: true, reason: `Approved by ${actorEmail} for threat ${ev._id}`, expiresAt: new Date(Date.now() + Math.min(Number(minutes) || 60, 1440) * 60000).toISOString(), actorEmail, actorType: "human" });
  if (l.error) return l;
  await nasThreatEvents.updateOne({ _id: ev._id }, { $set: { "protection.lockdown": { state: "ACTIVE", automatic: false, approvedBy: actorEmail, since: iso(), expiresAt: l.lockdown.expiresAt } } });
  return { lockdown: l.lockdown };
}

export async function liftLockdown({ orgId, shareId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await setLockdown({ orgId, shareId, active: false, actorEmail, actorType: "human" });
  if (r.error) return r;
  const { nasThreatEvents } = await getOrgCollections();
  await nasThreatEvents.updateMany({ orgId: toObjectId(orgId), shareId: toObjectId(shareId), "protection.lockdown.state": "ACTIVE" }, { $set: { "protection.lockdown.state": "LIFTED", "protection.lockdown.liftedAt": iso() } });
  return r;
}

/** Lifts every lockdown whose time is up (runs from the worker). */
export async function liftExpiredLockdowns({ orgId } = {}) {
  const { nasShares } = await getOrgCollections();
  const q = { deletedAt: null, "access.lockdown.active": true, "access.lockdown.expiresAt": { $lte: iso() } };
  if (orgId) q.orgId = toObjectId(orgId);
  const lifted = [];
  for (const s of await nasShares.find(q).toArray()) {
    const r = await setLockdown({ orgId: s.orgId, shareId: s._id, active: false, actorEmail: "system", actorType: "system" });
    if (!r.error) lifted.push(String(s._id));
  }
  return { lifted };
}

export async function listThreatEvents({ orgId, shareId, state, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasThreatEvents } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (shareId) q.shareId = toObjectId(shareId);
  if (state) q.state = state;
  return { events: await nasThreatEvents.find(q).sort({ detectedAt: -1 }).limit(100).toArray() };
}

/** Marks an event handled and points at the recovery path (human decision). */
export async function resolveThreatEvent({ orgId, eventId, resolution, note, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!["FALSE_POSITIVE", "CONTAINED", "RECOVERED"].includes(resolution)) return fail("resolution must be FALSE_POSITIVE, CONTAINED or RECOVERED.");
  const { nasThreatEvents } = await getOrgCollections();
  const ev = await nasThreatEvents.findOne({ _id: toObjectId(eventId), orgId: toObjectId(orgId) });
  if (!ev) return fail("Threat event not found.", 404);
  await nasThreatEvents.updateOne({ _id: ev._id }, { $set: { state: "RESOLVED", resolution, resolutionNote: note ? String(note).slice(0, 500) : null, resolvedBy: actorEmail, resolvedAt: iso() } });
  if (resolution === "FALSE_POSITIVE") {
    const res = await loadShare({ orgId, shareId: ev.shareId });
    if (!res.error) await res.agent.call("scan_baseline", { share: res.share.shareName }, { timeout: 300000 }).catch(() => {});
  }
  await recordNasEvidence({ orgId, applianceId: ev.applianceId, subjectId: ev.shareId, action: "POLICY_CHANGED", actorEmail, data: { change: "threat-resolved", eventId: String(ev._id), resolution }, graph: false });
  const clean = await lastCleanSnapshot({ orgId, shareId: ev.shareId, before: ev.detectedAt });
  return { resolved: true, recoveryPath: clean ? { snapshot: clean.name, snapshotId: String(clean._id), createdAt: clean.createdAt, hint: "Restore from this snapshot (into .restored/ first) to recover the last clean state." } : null };
}

registerJobHandler("threat_scan", async (job) => ({ result: await scanShare({ orgId: job.orgId, shareId: job.shareId }) }));

export async function enqueueDueScans({ orgId } = {}) {
  const { nasShares } = await getOrgCollections();
  const q = { deletedAt: null, "threatPolicy.enabled": true, "threatPolicy.nextScanAt": { $lte: iso() } };
  if (orgId) q.orgId = toObjectId(orgId);
  let queued = 0;
  for (const s of await nasShares.find(q).toArray()) {
    const iv = s.threatPolicy.scanIntervalMinutes || 15;
    const bucket = Math.floor(Date.now() / (iv * 60000));
    const r = await enqueueJob({ orgId: s.orgId, applianceId: s.applianceId, shareId: s._id, kind: "threat_scan", idempotencyKey: `scan:${s._id}:${bucket}` });
    if (r.created) queued++;
    await nasShares.updateOne({ _id: s._id }, { $set: { "threatPolicy.nextScanAt": new Date(Date.now() + iv * 60000).toISOString() } });
  }
  return { queued };
}
