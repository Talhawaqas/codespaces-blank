// src/lib/devices/devices.js
//
// Device inventory and control (Competitive Expansion SOW G2/G3, DEVICE-001/002). A "device" is one install of an Inaya client (browser, desktop
// app, mobile app) for one person in one organization. Clients check in with POST /api/orgs/devices/heartbeat; the check-in upserts the record,
// binds the current session to the device, and returns any pending commands. Collections: org_devices.
//
// Commands an admin (or the owner of the device) can issue: revoke, block, unblock, trust, require re-authentication, sign out everywhere on that
// device, request an application-data cache wipe, disable sync. "Wipe" means the Inaya app is asked to delete ITS OWN offline data on that device
// (chat and notes caches, offline files, tokens). Inaya cannot erase an operating system or other apps: this is an application-data wipe only,
// and it only takes effect when the client next checks in.
//
// Enforcement: a blocked or revoked device loses its sessions immediately; a session bound to a blocked device is refused by deviceGate.js (called
// from requireMembership); a device that has not checked in yet is unrestricted until it does (documented limit). IP metadata is stored masked
// (/24 or /48) and cleared after IP_RETENTION_DAYS. No fingerprinting: the device id is a random value the client generates and stores itself.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId, hashToken } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createNotification } from "../notifications.js";
import { effectivePolicies } from "../governance/policies.js";

export class DeviceError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new DeviceError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const lower = (v) => String(v ?? "").trim().toLowerCase();
export const PLATFORMS = ["web", "windows", "macos", "linux", "ios", "android", "other"];
export const COMMANDS = ["wipe_cache", "sign_out", "reauth", "disable_sync"];
export const IP_RETENTION_DAYS = 90;
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

let indexed = false;
async function col() {
  const c = await getOrgCollections(); const devices = c.db.collection("org_devices");
  if (!indexed) { await Promise.all([devices.createIndex({ orgId: 1, deviceId: 1 }, { unique: true }), devices.createIndex({ orgId: 1, email: 1, lastSeenAt: -1 }), devices.createIndex({ orgId: 1, lastSeenAt: -1 })]); indexed = true; }
  return { c, devices };
}
const maskIp = (ip) => { const s = String(ip || ""); if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/\.\d+$/, ".0/24"); if (s === "::1") return s; return s.includes(":") ? s.split(":").slice(0, 3).join(":").replace(/:+$/, "") + "::/48" : null; };
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

export const deviceView = (d) => ({ deviceId: d.deviceId, email: d.email, name: d.name, platform: d.platform, appVersion: d.appVersion, osVersion: d.osVersion, firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, lastIp: d.lastIpMasked || null, trust: d.trust, blockedAt: d.blockedAt || null, revokedAt: d.revokedAt || null, encryption: d.encryption || null, cache: d.cache || null, syncDisabled: !!d.syncDisabled, pendingCommands: (d.commands || []).filter((x) => !x.ackedAt).map((x) => ({ id: x.id, type: x.type, at: x.at })), suspect: d.suspect || null });

/** Check-in. Called by every client on start and periodically. Returns { status, commands } or throws DeviceError(403) for a blocked device. */
export async function heartbeat({ orgId, email, sessionToken, ip, report = {}, acks = [] }) {
  const { c, devices } = await col(); const id = String(report.deviceId || "");
  if (!DEVICE_ID.test(id)) fail(400, "deviceId must be 16 to 64 letters, digits, - or _.");
  const platform = PLATFORMS.includes(report.platform) ? report.platform : "other"; const now = nowIso(); const em = lower(email);
  const existing = await devices.findOne({ orgId: toObjectId(orgId), deviceId: id });
  if (existing && existing.email !== em) fail(409, "This device id belongs to another person.", { code: "DEVICE_OWNED" });
  if (existing && (existing.blockedAt || existing.revokedAt)) {
    if (sessionToken) await c.sessions.deleteOne({ tokenHash: hashToken(sessionToken) });
    fail(403, existing.revokedAt ? "This device has been removed from your account." : "This device is blocked by your organization.", { code: "DEVICE_BLOCKED" });
  }
  const set = { name: clean(report.name, 80) || existing?.name || `${platform} device`, platform, appVersion: clean(report.appVersion, 40) || null, osVersion: clean(report.osVersion, 60) || null, lastSeenAt: now, lastIpMasked: maskIp(ip), lastIpAt: now,
    encryption: { webcrypto: !!report.encryption?.webcrypto, secureStorage: !!report.encryption?.secureStorage, deviceLock: report.encryption?.deviceLock ?? null }, cache: { items: Number(report.cache?.items) || 0, bytes: Number(report.cache?.bytes) || 0, reportedAt: now } };
  if (existing) await devices.updateOne({ _id: existing._id }, { $set: set });
  else { try { await devices.insertOne({ _id: new ObjectId(), orgId: toObjectId(orgId), deviceId: id, email: em, firstSeenAt: now, trust: "unknown", commands: [], ...set }); } catch (e) { if (e?.code !== 11000) throw e; await devices.updateOne({ orgId: toObjectId(orgId), deviceId: id }, { $set: set }); } }
  if (acks?.length) await devices.updateOne({ orgId: toObjectId(orgId), deviceId: id }, { $set: { "commands.$[c].ackedAt": now } }, { arrayFilters: [{ "c.id": { $in: acks.map(String) }, "c.ackedAt": { $exists: false } }] });
  if (sessionToken) await c.sessions.updateOne({ tokenHash: hashToken(sessionToken) }, { $set: { deviceId: id } });
  const d = await devices.findOne({ orgId: toObjectId(orgId), deviceId: id });
  const pending = (d.commands || []).filter((x) => !x.ackedAt);
  const requireTrusted = (await effectivePolicies({ orgId: String(orgId), type: "device_access", ctx: { email: em } })).some((p) => p.config.requireTrustedDevice);
  return { status: { trust: d.trust, restricted: requireTrusted && d.trust !== "trusted", syncDisabled: !!d.syncDisabled }, commands: pending.map((x) => ({ id: x.id, type: x.type })) };
}

async function managedDevice({ orgId, membership, actorEmail, deviceId, allowSelf = false }) {
  const { devices } = await col(); const d = await devices.findOne({ orgId: toObjectId(orgId), deviceId: String(deviceId) }); if (!d) fail(404, "Device not found.");
  const admin = canManageOrg(membership); const self = lower(actorEmail) === d.email;
  if (!admin && !(allowSelf && self)) fail(403, "Only an owner or admin can do that.");
  return { d, devices, admin };
}
const audit = (orgId, d, actor, action, metadata = {}) => logOrgActivity({ orgId, recordType: "DEVICE", recordId: d._id, actorEmail: actor, action, previousState: null, newState: null, metadata: { deviceId: d.deviceId, person: d.email, ...metadata } }).catch(() => {});
async function killSessions(c, d) { const r = await c.sessions.deleteMany({ deviceId: d.deviceId, email: d.email }); return r.deletedCount; }

export async function listDevices({ orgId, membership, email, scope = "mine", limit = 200 }) {
  const { devices } = await col(); const admin = canManageOrg(membership); const q = { orgId: toObjectId(orgId) };
  if (scope !== "org" || !admin) q.email = lower(email);
  const rows = await devices.find(q).sort({ lastSeenAt: -1 }).limit(Math.min(limit, 500)).toArray();
  return { devices: rows.map(deviceView), scope: q.email ? "mine" : "org" };
}
export async function getDevice({ orgId, membership, actorEmail, deviceId }) { const { d } = await managedDevice({ orgId, membership, actorEmail, deviceId, allowSelf: true }); return deviceView(d); }

/** Actions: trust, untrust, block, unblock, revoke, signout, reauth (same effect today: sessions end; the next sign-in is a fresh login), wipe_cache, disable_sync, enable_sync. */
export async function deviceAction({ orgId, membership, actorEmail, deviceId, action }) {
  const { c } = await col(); const selfOk = ["revoke", "signout", "reauth", "wipe_cache"].includes(action);
  const { d, devices } = await managedDevice({ orgId, membership, actorEmail, deviceId, allowSelf: selfOk }); const now = nowIso(); const id = () => new ObjectId().toHexString();
  const push = (type) => devices.updateOne({ _id: d._id }, { $push: { commands: { id: id(), type, at: now, by: lower(actorEmail) } } });
  let result = {};
  switch (action) {
    case "trust": await devices.updateOne({ _id: d._id }, { $set: { trust: "trusted" } }); break;
    case "untrust": await devices.updateOne({ _id: d._id }, { $set: { trust: "unknown" } }); break;
    case "block": await devices.updateOne({ _id: d._id }, { $set: { blockedAt: now, trust: "blocked" } }); result.sessionsEnded = await killSessions(c, d); await push("sign_out"); break;
    case "unblock": await devices.updateOne({ _id: d._id }, { $set: { trust: "unknown" }, $unset: { blockedAt: "" } }); break;
    case "revoke": await devices.updateOne({ _id: d._id }, { $set: { revokedAt: now } }); result.sessionsEnded = await killSessions(c, d); await push("wipe_cache"); break;
    case "signout": case "reauth": result.sessionsEnded = await killSessions(c, d); await push(action === "reauth" ? "reauth" : "sign_out"); break;
    case "wipe_cache": await push("wipe_cache"); result.note = "The app clears its offline data the next time this device checks in."; break;
    case "disable_sync": await devices.updateOne({ _id: d._id }, { $set: { syncDisabled: true } }); await push("disable_sync"); break;
    case "enable_sync": await devices.updateOne({ _id: d._id }, { $set: { syncDisabled: false } }); break;
    default: fail(400, `action must be one of trust, untrust, block, unblock, revoke, signout, reauth, wipe_cache, disable_sync, enable_sync.`);
  }
  clearDeviceGateCache();
  await audit(orgId, d, actorEmail, action.toUpperCase(), result.sessionsEnded != null ? { sessionsEnded: result.sessionsEnded } : {});
  if (d.email !== lower(actorEmail)) { try { await createNotification({ scope: "org", orgId: String(orgId), targetEmail: d.email, category: "security", type: `device.${action}`, title: "A device on your account was changed", body: `An administrator applied “${action.replace("_", " ")}” to ${d.name}.`, sourceModule: "devices", sourceId: d.deviceId, actionUrl: "/business?view=devices", metadata: {}, dedupeKey: `dev:${d.deviceId}:${action}:${now.slice(0, 16)}` }); } catch { /* best effort */ } }
  return { ok: true, ...result };
}

/** Maintenance: IP metadata older than the retention period is cleared. Idempotent; wire to a cron. */
export async function purgeOldDeviceIps({ now = Date.now() } = {}) {
  const { devices } = await col(); const cutoff = new Date(now - IP_RETENTION_DAYS * 86400_000).toISOString();
  const r = await devices.updateMany({ lastIpAt: { $lt: cutoff }, lastIpMasked: { $ne: null } }, { $set: { lastIpMasked: null } }); return { cleared: r.modifiedCount };
}
export async function deviceSummary({ orgId, membership }) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can see the device summary."); const { devices } = await col(); const rows = await devices.find({ orgId: toObjectId(orgId) }).project({ platform: 1, trust: 1, blockedAt: 1, revokedAt: 1, lastSeenAt: 1, appVersion: 1, "encryption.secureStorage": 1 }).toArray();
  const stale = new Date(Date.now() - 30 * 86400_000).toISOString(); const by = {}; for (const r of rows) by[r.platform] = (by[r.platform] || 0) + 1;
  return { total: rows.length, byPlatform: by, trusted: rows.filter((r) => r.trust === "trusted").length, blocked: rows.filter((r) => r.blockedAt).length, revoked: rows.filter((r) => r.revokedAt).length, notSeen30Days: rows.filter((r) => r.lastSeenAt < stale && !r.revokedAt).length, withoutSecureStorage: rows.filter((r) => !r.encryption?.secureStorage && !r.revokedAt).length };
}

// ------------------------------------------------------------------------------------------------------------ gate
const cache = new Map(); const TTL = 10_000;
/** Called by requireMembership for a session bound to a device. Returns null (allowed) or { error, status }. Cached briefly; flag-gated. */
export async function deviceGate({ orgId, session }) {
  if (!session?.deviceId) return null; const key = `${orgId}:${session.deviceId}`; const hit = cache.get(key); if (hit && hit.until > Date.now()) return hit.verdict;
  let verdict = null;
  try {
    const { isFeatureEnabled } = await import("../featureFlags.js");
    if (await isFeatureEnabled("FEATURE_DEVICE_CONTROL", orgId)) {
      const { devices } = await col(); const d = await devices.findOne({ orgId: toObjectId(orgId), deviceId: session.deviceId });
      if (d?.blockedAt || d?.revokedAt) verdict = { error: "This device is blocked by your organization.", status: 403, code: "DEVICE_BLOCKED" };
      else if (d && d.trust !== "trusted" && (await effectivePolicies({ orgId: String(orgId), type: "device_access", ctx: { email: d.email } })).some((p) => p.config.requireTrustedDevice)) verdict = { error: "Your organization only allows trusted devices. Ask an administrator to trust this one.", status: 403, code: "DEVICE_NOT_TRUSTED" };
    }
  } catch { verdict = null; }
  cache.set(key, { verdict, until: Date.now() + TTL }); if (cache.size > 5000) cache.clear(); return verdict;
}
export const clearDeviceGateCache = () => cache.clear();
