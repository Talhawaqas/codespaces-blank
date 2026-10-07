// src/lib/pqc/deviceKeys.js
//
// PQC device key registry (Internxt-inspired SOW, Workstream A, PQC-A03/A04). Stores only PUBLIC
// key material and lifecycle state for a device's post-quantum key pair -- the private key is
// generated and kept on the device itself (custody-sdk's InayaKernel.Pqc.generateDeviceKeyPair(),
// see docs/architecture/pqc-architecture-adr.md), never sent here. No code path in this file
// accepts a field that could hold a private key.
//
// Device identity is REUSED from the existing device registry (../devices/devices.js's org_devices
// collection, deviceId format) rather than inventing a second device concept -- a PQC key always
// references a deviceId that must already exist in org_devices. Revoking a device there (block,
// revoke, wipe) does not automatically revoke its PQC key here; callers (the device-action route)
// should call revokeDeviceKeys() alongside that action so the two stay in lock-step without this
// module importing devices.js's write path directly (kept decoupled: a PQC-specific capability
// going away should never block the broader device revocation flow or vice versa).
//
// Collection: pqc_device_keys.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";

// Must exactly match custody-sdk's src/pqc/provider.js ALGORITHM_ID. Duplicated as a literal
// rather than imported via a relative path into custody-sdk's source tree (this app depends on
// the PUBLISHED @inaya-network/custody-sdk package everywhere else -- see clientCrypto.js -- and
// a relative source import here would be the one place that silently broke that boundary). The
// SDK's own test suite (custody-sdk/test/pqc.test.mjs) is this value's actual source of truth.
export const ALGORITHM_ID = "HYBRID-MLKEM768-X25519-HKDF-SHA256";

export class PqcDeviceKeyError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}
const fail = (status, message, extra) => { throw new PqcDeviceKeyError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const lower = (v) => String(v ?? "").trim().toLowerCase();
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

// Base64, length-bounded (the real ML-KEM-768 hybrid public key is 1216 bytes -> ~1624 base64
// chars; 4096 leaves headroom for a future, larger parameter set without being unbounded).
const PUBLIC_KEY_B64 = /^[A-Za-z0-9+/]{1,4096}={0,2}$/;

let indexed = false;
async function col() {
  const c = await getOrgCollections();
  const keys = c.db.collection("pqc_device_keys");
  if (!indexed) {
    await Promise.all([
      keys.createIndex({ orgId: 1, deviceId: 1, keyId: 1 }, { unique: true }),
      keys.createIndex({ orgId: 1, deviceId: 1, status: 1 }),
      keys.createIndex({ orgId: 1, email: 1 }),
    ]);
    indexed = true;
  }
  return { c, keys };
}

export const keyView = (k) => ({
  keyId: k.keyId,
  deviceId: k.deviceId,
  email: k.email,
  algorithm: k.algorithm,
  publicKey: k.publicKey,
  status: k.status,
  createdAt: k.createdAt,
  activatedAt: k.activatedAt || null,
  revokedAt: k.revokedAt || null,
});

const audit = (orgId, k, actorEmail, action, metadata = {}) =>
  logOrgActivity({ orgId, recordType: "PQC_DEVICE_KEY", recordId: k._id, actorEmail, action, previousState: null, newState: null, metadata: { deviceId: k.deviceId, keyId: k.keyId, algorithm: k.algorithm, ...metadata } }).catch(() => {});

async function requireDeviceOwnership({ orgId, email, deviceId }) {
  const { c } = await col();
  const device = await c.db.collection("org_devices").findOne({ orgId: toObjectId(orgId), deviceId: String(deviceId) });
  if (!device) fail(404, "Device not found. Register the device (POST /api/orgs/devices/heartbeat) before registering its PQC key.");
  if (lower(device.email) !== lower(email)) fail(403, "You can only register a PQC key for your own device.");
  if (device.blockedAt || device.revokedAt) fail(403, "This device is blocked or revoked and cannot register a new key.", { code: "DEVICE_BLOCKED" });
  return device;
}

/**
 * Registers one device's PQC public key. The device generates its own key pair locally
 * (custody-sdk InayaKernel.Pqc.generateDeviceKeyPair()) and sends only the public half here.
 * A device may hold more than one key (e.g. during a rotation window); the new key starts
 * "active" immediately -- callers that need an overlap/grace period handle that at the envelope
 * layer, not by withholding activation here.
 */
export async function registerDeviceKey({ orgId, email, deviceId, algorithm = ALGORITHM_ID, publicKey }) {
  if (!DEVICE_ID.test(String(deviceId || ""))) fail(400, "deviceId must be 16 to 64 letters, digits, - or _.");
  if (algorithm !== ALGORITHM_ID) fail(400, `Unsupported algorithm "${algorithm}". Supported: ${ALGORITHM_ID}.`);
  if (!PUBLIC_KEY_B64.test(String(publicKey || ""))) fail(400, "publicKey must be base64-encoded public key material.");

  await requireDeviceOwnership({ orgId, email, deviceId });
  const { keys } = await col();
  const now = nowIso();
  const doc = {
    _id: new ObjectId(),
    orgId: toObjectId(orgId),
    deviceId: String(deviceId),
    email: lower(email),
    keyId: new ObjectId().toHexString(),
    algorithm,
    publicKey: String(publicKey),
    status: "active",
    createdAt: now,
    activatedAt: now,
    revokedAt: null,
  };
  await keys.insertOne(doc);
  await audit(orgId, doc, email, "PQC_KEY_REGISTERED");
  return keyView(doc);
}

/** Lists this caller's own device keys, or (with deviceAdmin) every key in the org. */
export async function listDeviceKeys({ orgId, membership, email, scope = "mine", hasAdminRole, limit = 200 }) {
  const { keys } = await col();
  const admin = typeof hasAdminRole === "function" ? hasAdminRole(membership, "deviceAdmin", { read: true }) : false;
  const q = { orgId: toObjectId(orgId) };
  if (scope !== "org" || !admin) q.email = lower(email);
  const rows = await keys.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).toArray();
  return { keys: rows.map(keyView), scope: q.email ? "mine" : "org" };
}

/** Resolves the currently-active key for a device -- what a sender looks up before wrapping a content key to this recipient. Returns null, never a revoked/stale key, if none is active. */
export async function activeKeyForDevice({ orgId, deviceId }) {
  const { keys } = await col();
  return keys.findOne({ orgId: toObjectId(orgId), deviceId: String(deviceId), status: "active" }, { sort: { createdAt: -1 } });
}

/**
 * Revokes one device key. Self-service (the device owner can revoke their own key, e.g. after
 * rotating) or deviceAdmin (revoking someone else's, e.g. as part of device offboarding). Per
 * the ADR: revocation never retroactively destroys already-issued ciphertext -- it only stops
 * NEW sharing/Meet/backup operations from targeting this key.
 */
export async function revokeDeviceKey({ orgId, membership, actorEmail, deviceId, keyId, reason, hasAdminRole }) {
  const { keys } = await col();
  const k = await keys.findOne({ orgId: toObjectId(orgId), deviceId: String(deviceId), keyId: String(keyId) });
  if (!k) fail(404, "PQC key not found.");
  const admin = typeof hasAdminRole === "function" ? hasAdminRole(membership, "deviceAdmin") : false;
  const self = lower(actorEmail) === k.email;
  if (!admin && !self) fail(403, "Only the device owner or an admin can revoke that key.");
  if (k.status === "revoked") return keyView(k);

  const now = nowIso();
  await keys.updateOne({ _id: k._id }, { $set: { status: "revoked", revokedAt: now } });
  const updated = { ...k, status: "revoked", revokedAt: now };
  await audit(orgId, updated, actorEmail, "PQC_KEY_REVOKED", { reason: String(reason || "").slice(0, 200) || undefined });
  return keyView(updated);
}

/** Revokes every active PQC key for a device in one call -- used alongside a device-level revoke/block/wipe action so the two stay in lock-step. Never throws if the device had no PQC keys. */
export async function revokeAllKeysForDevice({ orgId, deviceId, actorEmail, reason }) {
  const { keys } = await col();
  const active = await keys.find({ orgId: toObjectId(orgId), deviceId: String(deviceId), status: "active" }).toArray();
  const now = nowIso();
  for (const k of active) {
    await keys.updateOne({ _id: k._id }, { $set: { status: "revoked", revokedAt: now } });
    await audit(orgId, { ...k, status: "revoked", revokedAt: now }, actorEmail, "PQC_KEY_REVOKED", { reason: String(reason || "device revoked").slice(0, 200) });
  }
  return { revokedCount: active.length };
}
