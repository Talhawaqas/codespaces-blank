// src/lib/ransomware/cloud.js
//
// Cloud-file ransomware signals (Competitive Expansion SOW workstream F, RANSOM-001). The NAS appliance already has a measured detector
// (src/lib/nas/ransomware.js); this applies the same idea to files reached through the S3/Azure API and DirectSync: measure what one actor (an
// API credential or a person) does in a short window and score it. It is NOT a perfect detector: every signal records its rule, counts and a
// confidence, and the response is bounded and reversible.
//
// Signals (per actor, rolling window): mass overwrites, mass deletes, extension anomalies (known ransomware extensions), encryption-like
// rewrites (new content entropy >= 7.5 bits/byte and up by >= 1.0 versus the version it replaced), ransom-note file names, burst downloads,
// burst share creation, and a TRIPWIRE: a hidden canary object that no legitimate client touches.
// Response: an alert with the evidence; at the policy's level an automatic CONTAINMENT of the actor (writes and deletes refused, reads allowed),
// which always expires and can be lifted by an admin; rollback assistance that lists what the actor changed and restores previous versions on
// request (versioned buckets). Nothing here deletes or encrypts data. Impossible-travel detection needs geolocation Inaya does not collect, so
// it is not offered.
// Collections: cloud_file_activity (TTL), security_signals, ransomware_containments, ransomware_policy.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { hasAdminRole } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createNotification } from "../notifications.js";

export class RansomError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new RansomError(status, message, extra); };
const nowIso = () => new Date().toISOString();
export const LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const DEFAULT_THRESHOLDS = { windowMinutes: 10, overwrites: 25, deletes: 25, extensionChanges: 5, highEntropyRewrites: 5, downloads: 150, shares: 12, ransomNotes: 1 };
export const DEFAULT_POLICY = { enabled: true, autoContainLevel: "CRITICAL", containMinutes: 60, thresholds: DEFAULT_THRESHOLDS };
export const CANARY_PREFIX = ".inaya-canary/";
const SYSTEM_ACTORS = /^(ai-|cloud-backup|doc-intelligence|ml-studio|system|workflow|ai_)/i;
const RANSOM_EXT = new Set(["locked", "lockbit", "encrypted", "crypt", "crypted", "enc", "wncry", "wnry", "ryk", "ryuk", "conti", "cerber", "locky", "zepto", "odin", "thor", "crypz", "cryptolocker", "petya", "akira", "blackcat", "royal", "play", "hive", "basta", "abcd", "id-locked"]);
const RANSOM_NOTE = /(^|[\\/])(readme[_ -]?(to[_ -]?)?(decrypt|restore|recover|files?)|how[_ -]?to[_ -]?(decrypt|recover|restore)|decrypt[_ -]?(your[_ -]?)?files?|restore[_ -]?(your[_ -]?)?files?|_?recover[_ -]?files|!+_?help|@please_read_me@|ransom)/i;

/** Shannon entropy of the first 32 KiB, in bits per byte (0..8). Encrypted or compressed data is close to 8. */
export function entropyOf(buf) {
  const b = buf.length > 32768 ? buf.subarray(0, 32768) : buf; if (!b.length) return 0; const f = new Array(256).fill(0); for (const x of b) f[x]++;
  let h = 0; for (const n of f) if (n) { const p = n / b.length; h -= p * Math.log2(p); } return Math.round(h * 1000) / 1000;
}
const extOf = (k) => (String(k).includes(".") ? String(k).split(".").pop().toLowerCase() : "");
export const isRansomExtension = (key) => RANSOM_EXT.has(extOf(key)) || /\.[a-z0-9]{2,6}\.(id-[a-z0-9]{6,}|[a-f0-9]{8,})$/i.test(String(key));
export const isRansomNote = (key) => RANSOM_NOTE.test(String(key));

/** Pure. Turn measured counts into a level, score, reasons and per-rule evidence. */
export function classifyCloudThreat(s, t = DEFAULT_THRESHOLDS) {
  const th = { ...DEFAULT_THRESHOLDS, ...t }; const reasons = []; const rules = []; let score = 0; const add = (pts, rule, text) => { score += pts; reasons.push(text); rules.push(rule); };
  if (s.canaryTouched) add(80, "canary_touched", `A hidden tripwire file was ${s.canaryTouched > 1 ? "touched " + s.canaryTouched + " times" : "touched"}; no legitimate client uses it`);
  if (s.ransomNotes >= th.ransomNotes) add(50, "ransom_note_names", `${s.ransomNotes} file(s) with ransom-note style names were written`);
  if (s.extensionChanges >= th.extensionChanges) add(40, "extension_anomaly", `${s.extensionChanges} files were written with known ransomware extensions`);
  if (s.highEntropyRewrites >= th.highEntropyRewrites) add(40, "encryption_like_rewrites", `${s.highEntropyRewrites} files were overwritten with encryption-like content`);
  if (s.overwrites >= th.overwrites) add(25, "mass_overwrite", `${s.overwrites} existing files were overwritten in ${th.windowMinutes} minutes`);
  if (s.deletes >= th.deletes) add(25, "mass_delete", `${s.deletes} files were deleted in ${th.windowMinutes} minutes`);
  if (s.downloads >= th.downloads) add(20, "burst_download", `${s.downloads} downloads in ${th.windowMinutes} minutes`);
  if (s.shares >= th.shares) add(25, "burst_sharing", `${s.shares} share links were created in ${th.windowMinutes} minutes`);
  const level = score >= 80 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : score > 0 ? "LOW" : "NONE";
  return { level, score, reasons, rules, confidence: Math.min(0.95, Math.round((0.35 + score / 160) * 100) / 100) };
}

const flagCache = new Map();
/** Feature flag with a short cache: these hooks sit on every storage write. */
async function flagOn(orgId) {
  const k = String(orgId); const hit = flagCache.get(k); if (hit && hit.until > Date.now()) return hit.on;
  let on = false; try { on = await (await import("../featureFlags.js")).isFeatureEnabled("FEATURE_RANSOMWARE_SIGNALS", orgId); } catch { on = false; }
  flagCache.set(k, { on, until: Date.now() + 30_000 }); if (flagCache.size > 2000) flagCache.clear(); return on;
}
export const clearRansomwareFlagCache = () => flagCache.clear();

let indexed = false;
async function cols() {
  const c = await getOrgCollections(); const activity = c.db.collection("cloud_file_activity"); const signals = c.db.collection("security_signals"); const contain = c.db.collection("ransomware_containments"); const policy = c.db.collection("ransomware_policy");
  if (!indexed) { await Promise.all([activity.createIndex({ at: 1 }, { expireAfterSeconds: 3 * 86400 }), activity.createIndex({ orgId: 1, actorKey: 1, at: -1 }), signals.createIndex({ orgId: 1, at: -1 }), contain.createIndex({ orgId: 1, actorKey: 1, until: -1 }), policy.createIndex({ orgId: 1 }, { unique: true })]); indexed = true; }
  return { c, activity, signals, contain, policy };
}
export async function getPolicy(orgId) { const { policy } = await cols(); const p = await policy.findOne({ orgId: toObjectId(orgId) }); return { ...DEFAULT_POLICY, ...(p || {}), thresholds: { ...DEFAULT_THRESHOLDS, ...(p?.thresholds || {}) } }; }
export async function setPolicy({ orgId, membership, actorEmail, enabled = true, autoContainLevel = "CRITICAL", containMinutes = 60, thresholds = {} }) {
  if (!hasAdminRole(membership, "securityAdmin")) fail(403, "Only an owner or admin can change the ransomware policy."); const { policy } = await cols();
  if (!["NONE", "HIGH", "CRITICAL"].includes(autoContainLevel)) fail(400, "autoContainLevel must be NONE, HIGH or CRITICAL."); if (!(containMinutes >= 5 && containMinutes <= 1440)) fail(400, "containMinutes must be 5 to 1440.");
  const clean = {}; for (const k of Object.keys(DEFAULT_THRESHOLDS)) if (thresholds[k] != null) { const n = Number(thresholds[k]); if (!(n >= 1 && n <= 100000)) fail(400, `${k} must be 1 to 100000.`); clean[k] = n; }
  await policy.updateOne({ orgId: toObjectId(orgId) }, { $set: { enabled: !!enabled, autoContainLevel, containMinutes, thresholds: { ...DEFAULT_THRESHOLDS, ...clean }, updatedBy: actorEmail, updatedAt: nowIso() } }, { upsert: true });
  await logOrgActivity({ orgId, recordType: "RANSOMWARE_POLICY", recordId: new ObjectId(), actorEmail, action: "POLICY_SET", previousState: null, newState: null, metadata: { enabled: !!enabled, autoContainLevel, containMinutes } }).catch(() => {}); return getPolicy(orgId);
}

// ---------------------------------------------------------------------------------------------------------- containment
/** Refuses writes and deletes from a contained actor. Called from the storage chokepoints. Reads stay allowed. */
export async function assertNotContained({ orgId, actorKey }) {
  if (!actorKey || !(await flagOn(orgId))) return; const { contain } = await cols(); const c = await contain.findOne({ orgId: toObjectId(orgId), actorKey: String(actorKey), liftedAt: null, until: { $gt: nowIso() } });
  if (c) { const e = new Error(`Writes from this credential are paused because unusual file activity was detected (${c.level}). An administrator can review and lift this.`); e.reason = "Contained"; e.name = "ObjectProtectedError"; throw e; }
}
async function containActor({ orgId, actorKey, level, signalId, minutes }) {
  const { contain } = await cols(); const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await contain.updateOne({ orgId: toObjectId(orgId), actorKey, liftedAt: null }, { $set: { level, signalId: String(signalId), until, at: nowIso() }, $setOnInsert: { _id: new ObjectId(), liftedAt: null } }, { upsert: true }); return until;
}
export async function liftContainment({ orgId, membership, actorEmail, actorKey }) {
  if (!hasAdminRole(membership, "securityAdmin")) fail(403, "Only an owner or admin can lift a containment."); const { contain } = await cols();
  const r = await contain.updateMany({ orgId: toObjectId(orgId), actorKey, liftedAt: null }, { $set: { liftedAt: nowIso(), liftedBy: actorEmail } }); if (!r.modifiedCount) fail(404, "That actor is not contained.");
  await logOrgActivity({ orgId, recordType: "RANSOMWARE_SIGNAL", recordId: new ObjectId(), actorEmail, action: "CONTAINMENT_LIFTED", previousState: null, newState: null, metadata: { actorKey } }).catch(() => {}); return { ok: true };
}

// ------------------------------------------------------------------------------------------------------------ recording
/** Record one file event. Best effort: a failure here never blocks the file operation. kind: write | overwrite | delete | download | share_create. */
export async function noteActivity({ orgId, actorKey, kind, bucket = null, key = null, versionId = null, entropy = null, prevEntropy = null, deviceId = null }) {
  try {
    if (!actorKey || SYSTEM_ACTORS.test(String(actorKey)) || !(await flagOn(orgId))) return null; const pol = await getPolicy(orgId); if (!pol.enabled) return null;
    const { activity } = await cols(); const k = String(key || "");
    const row = { orgId: toObjectId(orgId), actorKey: String(actorKey), kind, bucket, key: k.slice(0, 500), versionId, entropy, prevEntropy, deviceId, at: new Date(),
      flags: { canary: k.startsWith(CANARY_PREFIX), note: kind !== "delete" && kind !== "download" && isRansomNote(k), ransomExt: (kind === "write" || kind === "overwrite") && isRansomExtension(k), encLike: kind === "overwrite" && entropy != null && prevEntropy != null && entropy >= 7.5 && entropy - prevEntropy >= 1.0 } };
    await activity.insertOne(row);
    const destructive = kind === "delete" || kind === "overwrite" || row.flags.canary || row.flags.note || row.flags.ransomExt;
    if (destructive || kind === "download" || kind === "share_create") return await evaluateActor({ orgId, actorKey: row.actorKey, onlyIf: destructive ? "always" : "every10" });
    return null;
  } catch { return null; }
}
const lastEval = new Map();
/** Count the actor's recent activity, classify it, and (if warranted) raise a signal and contain. Throttled per actor. */
export async function evaluateActor({ orgId, actorKey, onlyIf = "always", now = Date.now() }) {
  const pol = await getPolicy(orgId); const t = pol.thresholds; const key = `${orgId}:${actorKey}`;
  if (onlyIf === "every10") { if ((lastEval.get(key) || 0) > now - 10_000) return null; lastEval.set(key, now); if (lastEval.size > 5000) lastEval.clear(); }
  const { activity, signals } = await cols(); const since = new Date(now - t.windowMinutes * 60_000);
  const rows = await activity.find({ orgId: toObjectId(orgId), actorKey: String(actorKey), at: { $gte: since } }).limit(20000).toArray();
  const count = (f) => rows.filter(f).length;
  const s = { overwrites: count((r) => r.kind === "overwrite"), deletes: count((r) => r.kind === "delete"), downloads: count((r) => r.kind === "download"), shares: count((r) => r.kind === "share_create"), ransomNotes: count((r) => r.flags?.note), extensionChanges: count((r) => r.flags?.ransomExt), highEntropyRewrites: count((r) => r.flags?.encLike), canaryTouched: count((r) => r.flags?.canary && r.kind !== "download") };
  const verdict = classifyCloudThreat(s, t); if (verdict.level === "NONE" || verdict.level === "LOW") return { level: verdict.level, raised: false, counts: s };
  const open = await signals.findOne({ orgId: toObjectId(orgId), actorKey: String(actorKey), state: "open", at: { $gt: new Date(now - 30 * 60_000).toISOString() } });
  const shouldContain = pol.autoContainLevel !== "NONE" && LEVELS.indexOf(verdict.level) >= LEVELS.indexOf(pol.autoContainLevel);
  if (open && LEVELS.indexOf(open.level) >= LEVELS.indexOf(verdict.level) && (open.contained || !shouldContain)) return { level: open.level, raised: false, counts: s, signalId: String(open._id) };
  const doc = { _id: open?._id || new ObjectId(), orgId: toObjectId(orgId), actorKey: String(actorKey), at: nowIso(), kind: "cloud_ransomware", level: verdict.level, score: verdict.score, confidence: verdict.confidence, rules: verdict.rules, reasons: verdict.reasons, counts: s, windowMinutes: t.windowMinutes, state: "open", source: "inaya-cloud-signals-v1", contained: false, sample: rows.filter((r) => r.kind !== "download").slice(-10).map((r) => ({ kind: r.kind, bucket: r.bucket, key: r.key })) };
  if (shouldContain) { doc.containedUntil = await containActor({ orgId, actorKey: String(actorKey), level: verdict.level, signalId: doc._id, minutes: pol.containMinutes }); doc.contained = true; }
  if (open) await signals.replaceOne({ _id: open._id }, doc); else await signals.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "RANSOMWARE_SIGNAL", recordId: doc._id, actorEmail: "system", action: open ? "SIGNAL_ESCALATED" : "SIGNAL_RAISED", previousState: null, newState: { level: doc.level }, metadata: { actorKey: doc.actorKey, level: doc.level, score: doc.score, rules: doc.rules, contained: doc.contained, counts: s } }).catch(() => {});
  import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId, type: "ransomware.signal", eventId: `${doc._id}:${doc.level}`, data: { signalId: String(doc._id), level: doc.level, score: doc.score, rules: doc.rules, contained: doc.contained, actorKey: doc.actorKey } })).catch(() => {});
  import("../notify/router.js").then((m) => m.notifyEvent({ orgId, event: "security.incident", audience: "admins", title: `Unusual file activity (${doc.level})`, body: `${doc.reasons[0]}${doc.contained ? ". Writes from this credential were paused." : ". Review it in Security."}`, link: "/business?view=ransomware", sourceId: String(doc._id), dedupeKey: `ransom:${doc._id}:${doc.level}`, protectedContent: false })).catch(() => {});
  return { level: doc.level, raised: true, contained: doc.contained, counts: s, signalId: String(doc._id) };
}

// ------------------------------------------------------------------------------------------------------- admin surface
const view = (e) => ({ signalId: String(e._id), at: e.at, actorKey: e.actorKey, level: e.level, score: e.score, confidence: e.confidence, rules: e.rules, reasons: e.reasons, counts: e.counts, state: e.state, contained: !!e.contained, containedUntil: e.containedUntil || null, source: e.source, sample: e.sample || [], resolution: e.resolution || null });
export async function listSignals({ orgId, membership, state = null, limit = 50 }) {
  if (!hasAdminRole(membership, "securityAdmin", { read: true })) fail(403, "Only a security administrator or auditor can see security signals."); const { signals, contain } = await cols(); const q = { orgId: toObjectId(orgId) }; if (state) q.state = state;
  const [rows, cons] = await Promise.all([signals.find(q).sort({ at: -1 }).limit(Math.min(limit, 200)).toArray(), contain.find({ orgId: toObjectId(orgId), liftedAt: null, until: { $gt: nowIso() } }).toArray()]);
  return { signals: rows.map(view), containments: cons.map((c) => ({ actorKey: c.actorKey, level: c.level, until: c.until, since: c.at })), policy: await getPolicy(orgId) };
}
export async function resolveSignal({ orgId, membership, actorEmail, signalId, resolution, note }) {
  if (!hasAdminRole(membership, "securityAdmin")) fail(403, "Only an owner or admin can resolve a signal."); if (!["false_positive", "confirmed", "acknowledged"].includes(resolution)) fail(400, "resolution must be false_positive, confirmed or acknowledged.");
  const { signals } = await cols(); const r = await signals.findOneAndUpdate({ _id: new ObjectId(signalId), orgId: toObjectId(orgId) }, { $set: { state: resolution === "acknowledged" ? "acknowledged" : "resolved", resolution: { kind: resolution, note: String(note || "").slice(0, 500), by: actorEmail, at: nowIso() } } }, { returnDocument: "after" });
  const e = r?.value ?? r; if (!e) fail(404, "Signal not found."); await logOrgActivity({ orgId, recordType: "RANSOMWARE_SIGNAL", recordId: e._id, actorEmail, action: "SIGNAL_" + resolution.toUpperCase(), previousState: null, newState: null, metadata: { actorKey: e.actorKey } }).catch(() => {}); return view(e);
}

/** What this actor changed in the window, with the previous version available to restore (versioned buckets). Read-only. */
export async function rollbackPreview({ orgId, membership, actorKey, sinceIso, store }) {
  if (!hasAdminRole(membership, "securityAdmin")) fail(403, "Only an owner or admin can plan a rollback."); const { activity } = await cols(); const s = store || (await import("../s3-compat/store.js"));
  const rows = await activity.find({ orgId: toObjectId(orgId), actorKey, kind: { $in: ["overwrite", "delete", "write"] }, at: { $gte: new Date(sinceIso) }, key: { $ne: null }, bucket: { $ne: null } }).sort({ at: 1 }).limit(2000).toArray();
  const seen = new Map(); for (const r of rows) { const id = `${r.bucket}/${r.key}`; if (!seen.has(id)) seen.set(id, r); }
  const out = [];
  for (const [id, r] of seen) {
    if (r.flags?.canary) continue; let versions = []; try { versions = (await s.listObjectVersions({ orgId, bucket: r.bucket, key: r.key })) || [] } catch { versions = []; }
    const before = versions.filter((v) => new Date(v.lastModified || v.createdAt || 0).getTime() < r.at.getTime()).sort((a, b) => new Date(b.lastModified || b.createdAt) - new Date(a.lastModified || a.createdAt))[0];
    out.push({ bucket: r.bucket, key: r.key, changedAs: r.kind, at: r.at, restorableVersionId: before?.versionId || null, note: before ? "A version from before the change exists." : r.kind === "write" ? "A new file; there is nothing earlier to restore." : "No earlier version is available (the bucket may not be versioned)." });
  }
  return { actorKey, since: sinceIso, objects: out, restorable: out.filter((o) => o.restorableVersionId).length };
}
export async function rollbackExecute({ orgId, membership, actorEmail, items, store }) {
  if (!hasAdminRole(membership, "securityAdmin")) fail(403, "Only an owner or admin can roll back files."); const s = store || (await import("../s3-compat/store.js")); const done = []; const failed = [];
  for (const it of (items || []).slice(0, 500)) { try { await s.restoreObjectVersion({ orgId, bucket: it.bucket, key: it.key, versionId: it.versionId, actorEmail }); done.push(`${it.bucket}/${it.key}`); } catch (e) { failed.push({ key: `${it.bucket}/${it.key}`, error: String(e.message).slice(0, 120) }); } }
  await logOrgActivity({ orgId, recordType: "RANSOMWARE_SIGNAL", recordId: new ObjectId(), actorEmail, action: "ROLLBACK_EXECUTED", previousState: null, newState: null, metadata: { restored: done.length, failed: failed.length } }).catch(() => {}); return { restored: done.length, failed };
}
/** Place a tripwire object in a bucket. Any write or delete of it by a client is a CRITICAL signal. */
export async function placeCanary({ orgId, membership, actorEmail, bucket, store }) {
  if (!hasAdminRole(membership, "securityAdmin")) fail(403, "Only an owner or admin can place a tripwire."); const s = store || (await import("../s3-compat/store.js"));
  const key = `${CANARY_PREFIX}do-not-touch-${new ObjectId().toHexString().slice(-8)}.txt`;
  await s.putS3Object({ orgId, bucket, key, bodyBuffer: Buffer.from("Inaya tripwire file. Nothing should read, change or delete this file. If you did, tell your administrator."), contentType: "text/plain", actorEmail: "system:tripwire" }); return { bucket, key };
}
export async function incidentReport({ orgId, membership, signalId }) {
  if (!hasAdminRole(membership, "securityAdmin", { read: true })) fail(403, "Only a security administrator or auditor can export an incident."); const { signals, activity, contain } = await cols(); const e = await signals.findOne({ _id: new ObjectId(signalId), orgId: toObjectId(orgId) }); if (!e) fail(404, "Signal not found.");
  const rows = await activity.find({ orgId: toObjectId(orgId), actorKey: e.actorKey, at: { $gte: new Date(new Date(e.at).getTime() - e.windowMinutes * 60_000 * 2) } }).sort({ at: 1 }).limit(2000).toArray();
  return { schemaVersion: "1.0", generatedAt: nowIso(), signal: view(e), timeline: rows.map((r) => ({ at: r.at, kind: r.kind, bucket: r.bucket, key: r.key, flags: Object.entries(r.flags || {}).filter(([, v]) => v).map(([k]) => k) })), containment: (await contain.find({ orgId: toObjectId(orgId), actorKey: e.actorKey }).toArray()).map((c) => ({ level: c.level, since: c.at, until: c.until, liftedAt: c.liftedAt })), disclosure: "Signals are heuristics measured from file activity, with a recorded rule and confidence. They are not proof of an attack and this report is not a forensic certification." };
}
