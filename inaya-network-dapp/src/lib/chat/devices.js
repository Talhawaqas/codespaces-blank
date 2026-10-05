// src/lib/chat/devices.js
//
// Device enrollment, KeyPackage publishing/claiming, and revocation (SOW A3, G2/G3 foundation).
// A device is one MLS client. The server learns its PUBLIC signature key only; private keys never leave the device.

import { canManageOrg } from "../orgs.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ChatError, LIMITS, b64, chatDb, deviceIdentity, fail, isId, newId, nowIso, normEmail, recordSecurityEvent } from "./common.js";
import { inspectKeyPackage } from "./mlsServer.js";
import { sha256Hex } from "./mlsServer.js";

const PLATFORMS = ["web", "ios", "android", "windows", "macos", "linux", "other"];
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

export function publicDevice(d) {
  return {
    deviceId: d.deviceId, label: d.label, platform: d.platform, appVersion: d.appVersion || null, osVersion: d.osVersion || null,
    status: d.status, fingerprint: d.fingerprint || null, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt || null,
    revokedAt: d.revokedAt || null, keyPackagesAvailable: d.keyPackagesAvailable ?? undefined,
  };
}

/** Step 1: reserve a device id. The client then builds its credential `inaya:v1:<org>:<email>:<deviceId>`. */
export async function enrollDevice({ orgId, email, label, platform, appVersion, osVersion }) {
  const em = normEmail(email);
  const rl = await slidingWindowCheck({ action: "chat:device-enroll", key: `${orgId}:${em}`, max: LIMITS.deviceEnrollsPerDay, windowMs: 24 * 3600 * 1000 });
  if (!rl.allowed) fail(429, "Too many device enrollments. Try again later.", "RATE_LIMITED");
  const { devices } = await chatDb();
  const active = await devices.countDocuments({ orgId: String(orgId), email: em, status: { $in: ["pending", "active"] } });
  if (active >= LIMITS.devicesPerUser) fail(409, `You can have at most ${LIMITS.devicesPerUser} active chat devices. Revoke one first.`, "DEVICE_LIMIT");
  const deviceId = newId(12);
  const doc = {
    deviceId, orgId: String(orgId), email: em, label: clean(label, 60) || "Device", platform: PLATFORMS.includes(platform) ? platform : "other",
    appVersion: clean(appVersion, 30) || null, osVersion: clean(osVersion, 40) || null, status: "pending",
    signaturePublicKeyHex: null, fingerprint: null, createdAt: nowIso(), lastSeenAt: null, revokedAt: null, revokedBy: null,
  };
  await devices.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "CHAT_DEVICE", recordId: deviceId, actorEmail: em, action: "ENROLLED", previousState: null, newState: null, metadata: { platform: doc.platform } });
  return { device: publicDevice(doc), identity: deviceIdentity(orgId, em, deviceId) };
}

export async function getActiveDevice({ orgId, email, deviceId }) {
  if (!isId(deviceId, 12)) return null;
  const { devices } = await chatDb();
  return devices.findOne({ deviceId, orgId: String(orgId), email: normEmail(email), status: { $in: ["pending", "active"] } });
}

export async function touchDevice(deviceId) {
  const { devices } = await chatDb();
  await devices.updateOne({ deviceId }, { $set: { lastSeenAt: nowIso() } });
}

/** Step 2: publish KeyPackages. Every package is decoded and checked against the authenticated caller and the device. */
export async function uploadKeyPackages({ orgId, email, deviceId, packages, lastResort = false }) {
  const em = normEmail(email);
  if (!Array.isArray(packages) || !packages.length) fail(400, "No KeyPackages supplied.");
  if (packages.length > LIMITS.keyPackagesPerUpload) fail(400, `At most ${LIMITS.keyPackagesPerUpload} KeyPackages per upload.`);
  const { devices, keyPackages } = await chatDb();
  const device = await devices.findOne({ deviceId, orgId: String(orgId), email: em, status: { $in: ["pending", "active"] } });
  if (!device) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const available = await keyPackages.countDocuments({ deviceId, status: "available" });
  if (available + packages.length > LIMITS.keyPackagesPerDevice) fail(409, "Too many KeyPackages are already stored for this device.", "KP_LIMIT");

  const rows = []; let pinned = device.signaturePublicKeyHex;
  for (const p of packages) {
    const bytes = b64.dec(p);
    if (bytes.length > LIMITS.maxKeyPackageBytes) fail(400, "KeyPackage too large.");
    const info = await inspectKeyPackage(bytes);
    if (info.identity.orgId !== String(orgId) || info.identity.email !== em || info.identity.deviceId !== deviceId) {
      await recordSecurityEvent({ orgId, email: em, deviceId, type: "KEYPACKAGE_IDENTITY_MISMATCH" });
      fail(403, "The KeyPackage credential does not match your authenticated identity.", "IDENTITY_MISMATCH");
    }
    if (pinned && pinned !== info.signaturePublicKeyHex) {
      await recordSecurityEvent({ orgId, email: em, deviceId, type: "KEYPACKAGE_SIGKEY_MISMATCH" });
      fail(403, "The KeyPackage signature key differs from the one enrolled for this device.", "SIGKEY_MISMATCH");
    }
    if (!pinned) pinned = info.signaturePublicKeyHex;
    if (info.notAfterMs && info.notAfterMs < Date.now() + 3600_000) fail(400, "KeyPackage lifetime is too short or already expired.", "BAD_LIFETIME");
    rows.push({
      deviceId, orgId: String(orgId), email: em, refHex: info.refHex, bytes: b64.enc(bytes), status: "available", lastResort: !!lastResort,
      createdAt: nowIso(), expiresAt: info.notAfterMs ? new Date(Math.min(info.notAfterMs, Date.now() + 120 * 86400_000)) : new Date(Date.now() + 120 * 86400_000),
    });
  }
  try { await keyPackages.insertMany(rows, { ordered: true }); }
  catch (err) { if (err?.code === 11000) fail(409, "A KeyPackage was already uploaded.", "KP_DUPLICATE"); throw err; }
  if (device.status === "pending") {
    const fingerprint = sha256Hex(Buffer.from(pinned, "hex"));
    await devices.updateOne({ deviceId, status: "pending" }, { $set: { status: "active", signaturePublicKeyHex: pinned, fingerprint } });
  }
  return { uploaded: rows.length, available: available + rows.length };
}

export async function keyPackageStatus({ orgId, email, deviceId }) {
  const { keyPackages } = await chatDb();
  const available = await keyPackages.countDocuments({ deviceId, status: "available", lastResort: false });
  const lastResort = await keyPackages.countDocuments({ deviceId, status: "available", lastResort: true });
  return { available, lastResort, lowWatermark: available < 10 };
}

/** Atomically takes ONE KeyPackage for each listed device (single use; a last-resort package is handed out, without being
 *  consumed, only when no single-use package is left). Each claim is bound to the claiming conversation and device; the
 *  caller (conversations.claimForCommit) has already checked the devices are in the conversation's plan. */
export async function claimKeyPackagesForDevices({ deviceIds, conversationId, claimerDeviceId }) {
  const { devices, keyPackages } = await chatDb();
  const targets = await devices.find({ deviceId: { $in: deviceIds }, status: "active" }).toArray();
  const out = []; const missing = [];
  for (const d of targets) {
    let kp = await keyPackages.findOneAndUpdate(
      { deviceId: d.deviceId, status: "available", lastResort: false, expiresAt: { $gt: new Date() } },
      { $set: { status: "claimed", claimedAt: nowIso(), claimedByConversation: conversationId, claimedByDevice: claimerDeviceId } },
      { returnDocument: "after" });
    if (!kp) kp = await keyPackages.findOne({ deviceId: d.deviceId, status: "available", lastResort: true, expiresAt: { $gt: new Date() } });
    if (!kp) { missing.push(d.deviceId); continue; }
    out.push({ deviceId: d.deviceId, email: d.email, fingerprint: d.fingerprint, keyPackage: kp.bytes, refHex: kp.refHex, lastResort: kp.lastResort });
  }
  return { packages: out, devicesWithoutKeyPackages: missing };
}

export async function listDevices({ orgId, email, all = false }) {
  const { devices, keyPackages } = await chatDb();
  const q = { orgId: String(orgId) }; if (!all) q.email = normEmail(email);
  const rows = await devices.find(q).sort({ createdAt: -1 }).limit(200).toArray();
  const out = [];
  for (const d of rows) out.push({ ...publicDevice({ ...d, keyPackagesAvailable: await keyPackages.countDocuments({ deviceId: d.deviceId, status: "available" }) }), email: d.email });
  return out;
}

/** Revoke a device. Allowed for its owner or an org owner/admin. Effects, all server-enforced:
 *  its KeyPackages are deleted, its Welcomes are dropped, every chat call with it is refused, and every conversation
 *  it was in is marked so that any member's client issues a Remove commit (new epoch it cannot decrypt). */
export async function revokeDevice({ orgId, membership, actorEmail, deviceId }) {
  const { devices, keyPackages, envelopes, conversations } = await chatDb();
  const d = await devices.findOne({ deviceId, orgId: String(orgId) });
  if (!d) fail(404, "Device not found.");
  if (d.email !== normEmail(actorEmail) && !canManageOrg(membership)) fail(403, "Only the device owner or an organization admin can revoke a device.");
  if (d.status === "revoked") return { device: publicDevice(d), alreadyRevoked: true };
  const now = nowIso();
  await devices.updateOne({ deviceId, status: { $ne: "revoked" } }, { $set: { status: "revoked", revokedAt: now, revokedBy: normEmail(actorEmail) } });
  await keyPackages.deleteMany({ deviceId });
  await envelopes.deleteMany({ recipientDeviceId: deviceId });
  // Every conversation whose MLS group still contains the device shows up with it in `devicesToRemove` on members' next
  // sync (conversation.leaves joined with device status), and their clients issue the Remove commit. Bump updatedAt so
  // long-polling clients wake up.
  await conversations.updateMany({ orgId: String(orgId), leaves: deviceId }, { $set: { updatedAt: now } });
  await recordSecurityEvent({ orgId, email: d.email, deviceId, type: "DEVICE_REVOKED", detail: `by ${normEmail(actorEmail)}` });
  await logOrgActivity({ orgId, recordType: "CHAT_DEVICE", recordId: deviceId, actorEmail, action: "REVOKED", previousState: null, newState: null, metadata: { owner: d.email } });
  return { device: publicDevice({ ...d, status: "revoked", revokedAt: now }) };
}
