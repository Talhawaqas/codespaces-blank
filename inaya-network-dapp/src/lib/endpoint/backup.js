// src/lib/endpoint/backup.js
//
// Endpoint backup v2 (Competitive Expansion SOW G1, ENDPOINT-001/002): the server side of DirectSync/desktop backup. The desktop client moves
// the bytes through the S3-compatible API as before; this module owns what the client does NOT: backup PROFILES (what to watch, when, how fast,
// how long to keep versions), the health picture built from the runs clients report, integrity verification against what is actually stored,
// and RESTORE JOBS (original or alternate location, point-in-time, ransomware-safe).
//
// Safety rules, enforced where the server can enforce them:
//   * a profile never deletes remote data unless it is explicitly in "mirror" mode AND the owner confirmed it; the mode is part of the config the
//     client receives. (The client talks to storage directly, so this is policy delivered to the client plus scoped credentials, not a server veto.)
//   * a restore that would run while the same device or credential has an open HIGH/CRITICAL ransomware signal defaults to a point in time BEFORE
//     the signal and needs a second person to approve.
//   * restore never overwrites silently: the default is keep-both ("name (restored)").
// Collections: endpoint_backup_profiles, endpoint_backup_runs (TTL 180 days), endpoint_restore_jobs.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { hasAdminRole } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createNotification } from "../notifications.js";

export class BackupError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new BackupError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const lower = (v) => String(v ?? "").trim().toLowerCase();
export const LIMITS = { folders: 20, patterns: 100, patternLen: 200, manifest: 5000, errors: 50, planFiles: 5000, verifyFiles: 2000 };
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/*.tmp", "**/~$*", "**/Thumbs.db", "**/.DS_Store"];

let indexed = false;
async function cols() {
  const c = await getOrgCollections(); const profiles = c.db.collection("endpoint_backup_profiles"); const runs = c.db.collection("endpoint_backup_runs"); const jobs = c.db.collection("endpoint_restore_jobs");
  if (!indexed) { await Promise.all([profiles.createIndex({ orgId: 1, email: 1 }), runs.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 86400 }), runs.createIndex({ orgId: 1, profileId: 1, at: -1 }), jobs.createIndex({ orgId: 1, createdAt: -1 })]); indexed = true; }
  return { c, profiles, runs, jobs };
}
const audit = (orgId, id, actor, action, metadata = {}) => logOrgActivity({ orgId, recordType: "ENDPOINT_BACKUP", recordId: id, actorEmail: actor, action, previousState: null, newState: null, metadata }).catch(() => {});
const oid = (v) => { if (!/^[0-9a-f]{24}$/.test(String(v))) fail(404, "Not found."); return new ObjectId(v); };

// ------------------------------------------------------------------------------------------------------------ profiles
function cleanPatterns(list, what) {
  const out = []; for (const p of Array.isArray(list) ? list : []) { const s = String(p).trim(); if (!s) continue; if (s.length > LIMITS.patternLen || /[\u0000-\u001f]/.test(s)) fail(400, `A ${what} pattern is not valid.`); out.push(s); } if (out.length > LIMITS.patterns) fail(400, `At most ${LIMITS.patterns} ${what} patterns.`); return out;
}
export function validateProfile(input, { partial = false } = {}) {
  const v = {}; const has = (k) => !partial || input[k] !== undefined;
  if (has("name")) { const n = String(input.name || "").trim(); if (!n || n.length > 80) fail(400, "Give the profile a name (80 characters at most)."); v.name = n; }
  if (has("folders")) {
    const f = Array.isArray(input.folders) ? input.folders : []; if (!f.length || f.length > LIMITS.folders) fail(400, `Choose 1 to ${LIMITS.folders} folders.`);
    v.folders = f.map((x) => { const p = String(x.path || "").trim(); if (!p || p.length > 500 || /[\u0000-\u001f]/.test(p) || p.split(/[\\/]/).includes("..")) fail(400, "A folder path is not valid."); return { path: p, include: cleanPatterns(x.include, "include"), exclude: cleanPatterns(x.exclude ?? DEFAULT_EXCLUDES, "exclude") }; });
  }
  if (has("schedule")) {
    const s = input.schedule || { mode: "manual" }; if (!["manual", "interval", "daily"].includes(s.mode)) fail(400, "schedule.mode must be manual, interval or daily.");
    if (s.mode === "interval" && !(Number(s.everyMinutes) >= 15 && Number(s.everyMinutes) <= 10080)) fail(400, "An interval schedule needs everyMinutes from 15 to 10080.");
    if (s.mode === "daily" && !(Number.isInteger(Number(s.atHour)) && Number(s.atHour) >= 0 && Number(s.atHour) <= 23)) fail(400, "A daily schedule needs atHour from 0 to 23.");
    v.schedule = { mode: s.mode, ...(s.mode === "interval" ? { everyMinutes: Number(s.everyMinutes) } : {}), ...(s.mode === "daily" ? { atHour: Number(s.atHour), timezone: String(s.timezone || "UTC").slice(0, 60) } : {}) };
  }
  if (has("bandwidthKbps")) { if (input.bandwidthKbps != null && !(Number(input.bandwidthKbps) >= 64 && Number(input.bandwidthKbps) <= 10_000_000)) fail(400, "bandwidthKbps must be 64 to 10000000, or empty for unlimited."); v.bandwidthKbps = input.bandwidthKbps == null ? null : Number(input.bandwidthKbps); }
  if (has("retention")) { const r = input.retention || {}; const versions = r.versions == null ? 30 : Number(r.versions); const days = r.days == null ? null : Number(r.days); if (!(versions >= 1 && versions <= 1000)) fail(400, "retention.versions must be 1 to 1000."); if (days != null && !(days >= 1 && days <= 36500)) fail(400, "retention.days must be 1 to 36500."); v.retention = { versions, days }; }
  if (has("bucket")) { if (!BUCKET.test(String(input.bucket || ""))) fail(400, "bucket must be a valid bucket name."); v.bucket = String(input.bucket); }
  if (has("prefix")) { const p = String(input.prefix || "").replace(/^\/+/, ""); if (p.length > 300 || p.split("/").includes("..")) fail(400, "prefix is not valid."); v.prefix = p; }
  if (has("mode")) { if (!["backup", "mirror"].includes(input.mode || "backup")) fail(400, "mode must be backup or mirror."); v.mode = input.mode || "backup"; if (v.mode === "mirror" && input.confirmMirrorDeletes !== true) fail(400, "Mirror mode deletes backed-up files when they are deleted on the device. Set confirmMirrorDeletes to true to accept that.", { code: "MIRROR_CONFIRM" }); v.confirmMirrorDeletes = v.mode === "mirror"; }
  if (has("deviceId")) v.deviceId = input.deviceId ? String(input.deviceId).slice(0, 64) : null;
  return v;
}
const view = (p) => ({ profileId: String(p._id), name: p.name, email: p.email, deviceId: p.deviceId || null, folders: p.folders, schedule: p.schedule, bandwidthKbps: p.bandwidthKbps ?? null, retention: p.retention, bucket: p.bucket, prefix: p.prefix || "", mode: p.mode || "backup", paused: !!p.paused, createdAt: p.createdAt, health: profileHealth(p), status: { lastRunAt: p.lastRunAt || null, lastSuccessAt: p.lastSuccessAt || null, lastFailureAt: p.lastFailureAt || null, lastFailure: p.lastFailure || null, changedFiles: p.changedFiles ?? null, retryQueue: p.retryQueue ?? 0 } });

export async function createProfile({ orgId, email, membership, input }) {
  const { profiles } = await cols(); const v = validateProfile({ mode: "backup", schedule: { mode: "manual" }, retention: {}, prefix: "", ...input });
  const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), email: lower(email), ...v, paused: false, createdAt: nowIso(), retryQueue: 0 };
  await profiles.insertOne(doc); await audit(orgId, doc._id, email, "PROFILE_CREATED", { name: doc.name, mode: doc.mode, folders: doc.folders.length }); return view(doc);
}
async function ownedProfile({ orgId, email, membership, profileId, adminOk = true }) {
  const { profiles } = await cols(); const p = await profiles.findOne({ _id: oid(profileId), orgId: toObjectId(orgId) }); if (!p) fail(404, "Profile not found.");
  if (p.email !== lower(email) && !(adminOk && hasAdminRole(membership, "storageAdmin"))) fail(404, "Profile not found."); return { p, profiles };
}
export async function updateProfile({ orgId, email, membership, profileId, patch }) {
  const { p, profiles } = await ownedProfile({ orgId, email, membership, profileId }); const set = {};
  if (patch.paused !== undefined) set.paused = !!patch.paused; const rest = { ...patch }; delete rest.paused;
  Object.assign(set, validateProfile({ ...rest, mode: patch.mode ?? undefined }, { partial: true })); if (!Object.keys(set).length) return view(p);
  await profiles.updateOne({ _id: p._id }, { $set: { ...set, updatedAt: nowIso() } }); await audit(orgId, p._id, email, patch.paused !== undefined && Object.keys(set).length === 1 ? (patch.paused ? "PROFILE_PAUSED" : "PROFILE_RESUMED") : "PROFILE_UPDATED", { fields: Object.keys(set) });
  return view(await profiles.findOne({ _id: p._id }));
}
export async function deleteProfile({ orgId, email, membership, profileId }) {
  const { p, profiles } = await ownedProfile({ orgId, email, membership, profileId }); await profiles.deleteOne({ _id: p._id }); await audit(orgId, p._id, email, "PROFILE_DELETED", { name: p.name, note: "Backed-up files are kept." }); return { ok: true, note: "The profile was removed. Files already backed up are kept." };
}
export async function listProfiles({ orgId, email, membership, scope = "mine" }) {
  const { profiles } = await cols(); const q = { orgId: toObjectId(orgId) }; if (scope !== "org" || !hasAdminRole(membership, "storageAdmin")) q.email = lower(email);
  return { profiles: (await profiles.find(q).sort({ createdAt: -1 }).limit(200).toArray()).map(view) };
}
/** What a client needs to run: its profiles, with mode and limits. A paused profile is returned as paused so the client stops. */
export async function clientConfig({ orgId, email, deviceId }) {
  const { profiles } = await cols(); const rows = await profiles.find({ orgId: toObjectId(orgId), email: lower(email), $or: [{ deviceId: null }, { deviceId: String(deviceId || "") }, { deviceId: { $exists: false } }] }).toArray();
  return { profiles: rows.map((p) => ({ profileId: String(p._id), name: p.name, folders: p.folders, schedule: p.schedule, bandwidthKbps: p.bandwidthKbps ?? null, retention: p.retention, bucket: p.bucket, prefix: p.prefix || "", mode: p.mode || "backup", deleteRemoteWhenLocalDeleted: p.mode === "mirror", paused: !!p.paused })) };
}

// -------------------------------------------------------------------------------------------------------------- health
/** Pure. GREEN: recent success; AMBER: late, retry queue, or partial; RED: failing or no success well past schedule; GREY: paused or never run. */
export function profileHealth(p, now = Date.now()) {
  if (p.paused) return { state: "PAUSED", reasons: ["The profile is paused."] };
  const every = p.schedule?.mode === "interval" ? p.schedule.everyMinutes * 60_000 : p.schedule?.mode === "daily" ? 24 * 3600_000 : null; const last = p.lastSuccessAt ? new Date(p.lastSuccessAt).getTime() : null; const reasons = [];
  if (!p.lastRunAt) return { state: "NEVER_RUN", reasons: ["It has not run yet."] };
  if (p.lastFailureAt && (!last || new Date(p.lastFailureAt) > new Date(p.lastSuccessAt))) { reasons.push(`The last run failed${p.lastFailure ? `: ${String(p.lastFailure).slice(0, 120)}` : ""}.`); return { state: "RED", reasons }; }
  if (every && last && now - last > every * 3) { reasons.push("No successful run for more than three schedule periods."); return { state: "RED", reasons }; }
  if (every && last && now - last > every * 1.5) reasons.push("The last successful run is later than the schedule."); if ((p.retryQueue || 0) > 0) reasons.push(`${p.retryQueue} file(s) are waiting to retry.`); if (p.lastRunStatus === "partial") reasons.push("The last run finished with some files failing.");
  return { state: reasons.length ? "AMBER" : "GREEN", reasons };
}
export async function healthOverview({ orgId, membership }) {
  if (!hasAdminRole(membership, "storageAdmin", { read: true })) fail(403, "Only a storage administrator or auditor can see backup health for everyone."); const { profiles } = await cols(); const rows = await profiles.find({ orgId: toObjectId(orgId) }).toArray(); const by = {}; const worst = [];
  for (const p of rows) { const h = profileHealth(p); by[h.state] = (by[h.state] || 0) + 1; if (h.state === "RED" || h.state === "AMBER") worst.push({ profileId: String(p._id), name: p.name, person: p.email, state: h.state, reasons: h.reasons }); }
  return { total: rows.length, byState: by, attention: worst.slice(0, 50) };
}

// ---------------------------------------------------------------------------------------------------------------- runs
/** A client reports a finished run. Updates the profile's health fields. The manifest (key, size, sha256/etag) is kept for integrity checks. */
export async function reportRun({ orgId, email, report }) {
  const { profiles, runs } = await cols(); const p = await profiles.findOne({ _id: oid(report.profileId), orgId: toObjectId(orgId), email: lower(email) }); if (!p) fail(404, "Profile not found.");
  if (!["ok", "partial", "failed"].includes(report.status)) fail(400, "status must be ok, partial or failed.");
  const f = report.files || {}; const num = (n) => Math.max(0, Math.floor(Number(n) || 0)); const errs = (Array.isArray(report.errors) ? report.errors : []).slice(0, LIMITS.errors).map((e) => ({ path: String(e.path || "").slice(0, 300), error: String(e.error || "").slice(0, 200) }));
  const manifest = (Array.isArray(report.manifest) ? report.manifest : []).slice(0, LIMITS.manifest).filter((m) => m && m.key).map((m) => ({ key: String(m.key).slice(0, 500), size: num(m.size), sha256: m.sha256 ? String(m.sha256).slice(0, 64) : null, etag: m.etag ? String(m.etag).slice(0, 80) : null }));
  const at = new Date(); const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), profileId: p._id, email: p.email, deviceId: report.deviceId || p.deviceId || null, at, startedAt: report.startedAt || null, finishedAt: report.finishedAt || at.toISOString(), status: report.status, files: { scanned: num(f.scanned), changed: num(f.changed), uploaded: num(f.uploaded), failed: num(f.failed), bytes: num(f.bytes) }, errors: errs, manifest, retryQueue: num(report.retryQueue), verification: null };
  await runs.insertOne(doc);
  if (report.status === "failed") import("../governance/events.js").then((m) => m.emitFileEvent(orgId, "backup_failed", { profileId: String(p._id), runId: String(doc._id) })).catch(() => {});
  const set = { lastRunAt: at.toISOString(), lastRunStatus: report.status, changedFiles: doc.files.changed, retryQueue: doc.retryQueue };
  if (report.status === "failed") { set.lastFailureAt = at.toISOString(); set.lastFailure = errs[0]?.error || "The run failed."; } else { set.lastSuccessAt = at.toISOString(); }
  await profiles.updateOne({ _id: p._id }, { $set: set });
  import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId, type: "backup.event", eventId: String(doc._id), data: { kind: "endpoint_backup_run", profileId: String(p._id), status: report.status, changed: doc.files.changed, failed: doc.files.failed } })).catch(() => {});
  if (report.status === "failed") import("../notify/router.js").then((m) => m.notifyEvent({ orgId, event: "backup.failed", targetEmail: p.email, title: "A backup run failed", body: `“${p.name}” failed: ${set.lastFailure}`, link: "/business?view=endpointBackup", sourceId: String(p._id), dedupeKey: `epb:${p._id}:${at.toISOString().slice(0, 13)}`, protectedContent: false })).catch(() => {});
  return { runId: String(doc._id), health: profileHealth({ ...p, ...set }) };
}
export async function listRuns({ orgId, email, membership, profileId, limit = 30 }) {
  const { p } = await ownedProfile({ orgId, email, membership, profileId }); const { runs } = await cols();
  const rows = await runs.find({ orgId: toObjectId(orgId), profileId: p._id }).sort({ at: -1 }).limit(Math.min(Number(limit) || 30, 100)).project({ manifest: 0 }).toArray();
  return { runs: rows.map((r) => ({ runId: String(r._id), at: r.at, status: r.status, files: r.files, errors: r.errors.slice(0, 5), retryQueue: r.retryQueue, verification: r.verification })) };
}
/** Compare a run's manifest with what is actually stored. `store` is injectable for tests. */
export async function verifyRun({ orgId, email, membership, profileId, runId, store }) {
  const { p } = await ownedProfile({ orgId, email, membership, profileId }); const { runs } = await cols(); const run = await runs.findOne({ _id: oid(runId), orgId: toObjectId(orgId), profileId: p._id }); if (!run) fail(404, "Run not found.");
  const s = store || (await import("../s3-compat/store.js")); const items = run.manifest.slice(0, LIMITS.verifyFiles); const out = { checked: 0, ok: 0, missing: [], mismatched: [] };
  for (const m of items) { out.checked++; let doc = null; try { doc = await s.headS3Object({ orgId, bucket: p.bucket, key: m.key }); } catch { doc = null; }
    if (!doc) { if (out.missing.length < 20) out.missing.push(m.key); continue; }
    const sizeOk = m.size == null || Number(doc.sizeBytes) === Number(m.size); const hashOk = !m.sha256 || !doc.sha256 || String(doc.sha256).toLowerCase() === String(m.sha256).toLowerCase();
    if (sizeOk && hashOk) out.ok++; else if (out.mismatched.length < 20) out.mismatched.push({ key: m.key, expectedSize: m.size, storedSize: doc.sizeBytes }); }
  const verification = { at: nowIso(), by: lower(email), checked: out.checked, ok: out.ok, missing: out.missing.length, mismatched: out.mismatched.length, truncated: run.manifest.length > items.length, missingKeys: out.missing, mismatchedItems: out.mismatched, result: out.checked === out.ok ? "VERIFIED" : "PROBLEMS" };
  await runs.updateOne({ _id: run._id }, { $set: { verification } }); await audit(orgId, p._id, email, "RUN_VERIFIED", { runId, result: verification.result, checked: out.checked }); return verification;
}

// --------------------------------------------------------------------------------------------------------------- restore
async function openRansomSignal({ orgId, p }) {
  const { c } = await cols(); const signals = c.db.collection("security_signals");
  const keys = [p.email, p.deviceId].filter(Boolean).flatMap((k) => [k, `user:${k}`]);
  return signals.findOne({ orgId: toObjectId(orgId), state: "open", level: { $in: ["HIGH", "CRITICAL"] }, $or: [{ actorKey: { $in: keys } }, { "sample.bucket": p.bucket }] }, { sort: { at: -1 } });
}
/** Build the list of versions to restore: for every file under the selection, the newest version no newer than the point in time. */
export async function buildRestorePlan({ orgId, p, selection = {}, pointInTime = null, store }) {
  const s = store || (await import("../s3-compat/store.js")); const prefix = String(selection.prefix ?? p.prefix ?? "").replace(/^\/+/, ""); const wanted = Array.isArray(selection.paths) && selection.paths.length ? new Set(selection.paths.map(String)) : null;
  const versions = (await s.listAllObjectVersions({ orgId, bucket: p.bucket, prefix })) || []; const cut = pointInTime ? new Date(pointInTime).getTime() : Infinity; const byKey = new Map();
  for (const v of versions) { if ((prefix && !String(v.key).startsWith(prefix)) || (wanted && !wanted.has(v.key))) continue; /* rows hidden by a delete marker still hold their bytes and can be restored */ const t = new Date(v.lastModified || v.createdAt || 0).getTime(); if (t > cut) continue; const cur = byKey.get(v.key); if (!cur || t > cur.t) byKey.set(v.key, { key: v.key, versionId: v.versionId, size: v.sizeBytes ?? null, t, versionAt: new Date(t).toISOString() }); }
  const files = [...byKey.values()].slice(0, LIMITS.planFiles).map(({ t, ...x }) => x); return { files, truncated: byKey.size > LIMITS.planFiles, bytes: files.reduce((a, f) => a + (Number(f.size) || 0), 0) };
}
export async function createRestoreJob({ orgId, email, membership, profileId, selection, pointInTime = null, target = "original", alternatePath = null, overwrite = false, reason = "", store }) {
  const { p } = await ownedProfile({ orgId, email, membership, profileId, adminOk: true }); const { jobs } = await cols();
  if (!["original", "alternate"].includes(target)) fail(400, "target must be original or alternate."); if (target === "alternate" && (!alternatePath || String(alternatePath).length > 500 || String(alternatePath).split(/[\\/]/).includes(".."))) fail(400, "An alternate location needs a valid folder path.");
  if (pointInTime && isNaN(new Date(pointInTime))) fail(400, "pointInTime must be a valid date."); if (overwrite && target === "original" && String(reason).trim().length < 5) fail(400, "Overwriting files at the original location needs a reason.");
  let pit = pointInTime; let needsApproval = false; const flags = [];
  const sig = await openRansomSignal({ orgId, p });
  if (sig) { const before = new Date(new Date(sig.at).getTime() - (sig.windowMinutes || 10) * 60_000 * 2).toISOString(); if (!pit || new Date(pit) > new Date(before)) { pit = before; flags.push(`An open ${sig.level} ransomware signal exists, so the restore uses a point in time before it (${before}).`); } needsApproval = true; flags.push("A second administrator must approve this restore."); }
  const plan = await buildRestorePlan({ orgId, p, selection, pointInTime: pit, store }); if (!plan.files.length) fail(409, "Nothing matches that selection and point in time.");
  const job = { _id: new ObjectId(), orgId: toObjectId(orgId), profileId: p._id, deviceId: p.deviceId || null, requestedBy: lower(email), createdAt: nowIso(), target, alternatePath: target === "alternate" ? String(alternatePath) : null, overwrite: !!overwrite, conflict: overwrite ? "overwrite" : "keep_both", selection: { prefix: selection?.prefix ?? null, paths: selection?.paths ?? null }, pointInTime: pit, plan, status: needsApproval ? "pending_approval" : "ready", flags, ransomwareSignalId: sig ? String(sig._id) : null, reason: String(reason).slice(0, 300), result: null };
  await jobs.insertOne(job); await audit(orgId, job._id, email, "RESTORE_REQUESTED", { profile: p.name, files: plan.files.length, target, needsApproval, pointInTime: pit }); return jobView(job);
}
const jobView = (j) => ({ jobId: String(j._id), profileId: String(j.profileId), requestedBy: j.requestedBy, createdAt: j.createdAt, target: j.target, alternatePath: j.alternatePath, conflict: j.conflict, pointInTime: j.pointInTime, status: j.status, flags: j.flags, files: j.plan.files.length, bytes: j.plan.bytes, truncated: j.plan.truncated, approvedBy: j.approvedBy || null, result: j.result });
export async function listRestoreJobs({ orgId, email, membership, status = null }) {
  const { jobs } = await cols(); const q = { orgId: toObjectId(orgId) }; if (status) q.status = status; if (!hasAdminRole(membership, "storageAdmin")) q.requestedBy = lower(email);
  return { jobs: (await jobs.find(q).sort({ createdAt: -1 }).limit(100).toArray()).map(jobView) };
}
export async function decideRestore({ orgId, membership, actorEmail, jobId, approve }) {
  if (!hasAdminRole(membership, "storageAdmin")) fail(403, "Only an owner or admin can approve a restore."); const { jobs } = await cols(); const j = await jobs.findOne({ _id: oid(jobId), orgId: toObjectId(orgId), status: "pending_approval" }); if (!j) fail(409, "That restore is not waiting for approval.");
  if (j.requestedBy === lower(actorEmail)) fail(403, "A different administrator must approve this restore.");
  await jobs.updateOne({ _id: j._id, status: "pending_approval" }, { $set: { status: approve ? "ready" : "rejected", approvedBy: lower(actorEmail), decidedAt: nowIso() } }); await audit(orgId, j._id, actorEmail, approve ? "RESTORE_APPROVED" : "RESTORE_REJECTED"); return { ok: true };
}
/** The desktop client picks up ready jobs for its profiles and posts the result. */
export async function claimRestoreJobs({ orgId, email, deviceId }) {
  const { jobs, profiles } = await cols(); const mine = (await profiles.find({ orgId: toObjectId(orgId), email: lower(email) }).project({ _id: 1 }).toArray()).map((p) => p._id);
  const ready = await jobs.find({ orgId: toObjectId(orgId), profileId: { $in: mine }, status: "ready", $or: [{ deviceId: null }, { deviceId: String(deviceId || "") }] }).limit(5).toArray();
  for (const j of ready) await jobs.updateOne({ _id: j._id, status: "ready" }, { $set: { status: "running", startedAt: nowIso() } });
  return { jobs: ready.map((j) => ({ ...jobView(j), plan: j.plan.files })) };
}
export async function reportRestore({ orgId, email, jobId, report }) {
  const { jobs, profiles } = await cols(); const j = await jobs.findOne({ _id: oid(jobId), orgId: toObjectId(orgId), status: "running" }); if (!j) fail(409, "That restore is not running.");
  const own = await profiles.findOne({ _id: j.profileId, email: lower(email) }); if (!own) fail(404, "Restore not found."); const n = (x) => Math.max(0, Math.floor(Number(x) || 0));
  const result = { restored: n(report.restored), failed: n(report.failed), bytes: n(report.bytes), errors: (report.errors || []).slice(0, 50).map((e) => ({ path: String(e.path || "").slice(0, 300), error: String(e.error || "").slice(0, 200) })), finishedAt: nowIso() };
  await jobs.updateOne({ _id: j._id }, { $set: { status: result.failed && !result.restored ? "failed" : result.failed ? "partial" : "completed", result } }); await audit(orgId, j._id, email, "RESTORE_FINISHED", { restored: result.restored, failed: result.failed }); return { ok: true };
}
export async function recoveryReport({ orgId, email, membership, jobId }) {
  const { jobs, profiles } = await cols(); const j = await jobs.findOne({ _id: oid(jobId), orgId: toObjectId(orgId) }); if (!j) fail(404, "Restore not found."); if (j.requestedBy !== lower(email) && !hasAdminRole(membership, "storageAdmin")) fail(404, "Restore not found.");
  const p = await profiles.findOne({ _id: j.profileId });
  const report = { schemaVersion: "1.0", generatedAt: nowIso(), job: jobView(j), profile: p ? { name: p.name, bucket: p.bucket, mode: p.mode } : null, plan: { files: j.plan.files.length, bytes: j.plan.bytes, truncated: j.plan.truncated, sample: j.plan.files.slice(0, 25) }, ransomwareSafe: { signalConsidered: j.ransomwareSignalId, approvedBy: j.approvedBy || null }, result: j.result, disclosure: "This report describes a restore requested through Inaya. It records what was planned and what the client reported; it is not an integrity attestation of the restored files." };
  const md = [`# Recovery report`, ``, `Requested by ${j.requestedBy} on ${j.createdAt}. Status: **${j.status}**.`, `Target: ${j.target}${j.alternatePath ? ` (${j.alternatePath})` : ""}; conflicts: ${j.conflict}. Point in time: ${j.pointInTime || "latest"}.`, `Plan: ${j.plan.files.length} files, ${j.plan.bytes} bytes.`, ...(j.flags || []).map((f) => `- ${f}`), j.result ? `Result: ${j.result.restored} restored, ${j.result.failed} failed.` : "Result: not reported yet.", "", report.disclosure].join("\n");
  return { report, markdown: md };
}
