// src/lib/filerequests/requests.js
//
// File requests (Competitive Expansion SOW B3, REQ-001..003): a secure way for someone OUTSIDE the organization to send files in, without
// an account and without being able to see anything. Inbound only: the public side can submit and nothing else; it cannot browse, list or
// download. Files are encrypted in the uploader's browser to a key only the requester can open (see clientCrypto.js), so Inaya stores
// ciphertext and CANNOT scan the content for malware (an honest consequence of end-to-end encryption, documented in
// docs/architecture/secure-sharing-model.md). Limits that can be enforced on metadata are enforced here: size, count, extension list, expiry,
// identity fields, rate limits. Collections: file_requests, file_request_uploads, file_request_parts.

import { createHash, randomBytes } from "node:crypto";
import { Binary } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { createNotification } from "../notifications.js";
import { logOrgActivity } from "../org-activity-log.js";
import { isValidPublicKeyJwk } from "./clientCrypto.js";
import { governUpload } from "../governance/uploads.js";
import { emitFileEvent } from "../governance/events.js";

export class RequestError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new RequestError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const norm = (e) => String(e || "").trim().toLowerCase();
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

export const LIMITS = { maxFilesMax: 100, maxFilesDefault: 10, fileBytesMax: 25 * 1024 * 1024, partBytes: 1536 * 1024, expiryMaxDays: 90, titleMax: 120, instructionsMax: 1000, wrappedKeyMax: 4096, envelopeMax: 2048, uploadsPerHourPerIp: 30, uploadsPerDayPerIp: 100, concurrentUploadsFactor: 2 };
export const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_CONFIDENTIAL", "RESTRICTED"];
/** Refused unless the requester lists the extension explicitly: executable and script formats that make a poor "document" upload. */
export const RISKY_EXTENSIONS = new Set(["exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "vbs", "vbe", "js", "jse", "jar", "app", "apk", "sh", "reg", "lnk", "hta", "cpl", "wsf", "pif", "iso", "docm", "xlsm", "pptm", "dotm", "xlsb", "xlam"]);

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const requests = c.db.collection("file_requests"); const uploads = c.db.collection("file_request_uploads"); const parts = c.db.collection("file_request_parts");
  if (!indexed) {
    await Promise.all([
      requests.createIndex({ tokenHash: 1 }, { unique: true }), requests.createIndex({ orgId: 1, createdByEmail: 1, createdAt: -1 }), requests.createIndex({ orgId: 1, createdAt: -1 }),
      uploads.createIndex({ requestId: 1, status: 1, createdAt: -1 }), uploads.createIndex({ requestId: 1, uploadKeyHash: 1 }, { unique: true, partialFilterExpression: { uploadKeyHash: { $type: "string" } } }),
      parts.createIndex({ uploadId: 1, index: 1 }, { unique: true }),
    ]);
    indexed = true;
  }
  return { ...c, requests, uploads, parts };
}

const statusOf = (r, now = Date.now()) => r.revokedAt ? "revoked" : new Date(r.expiresAt).getTime() <= now ? "expired" : (r.received || 0) >= r.maxFiles ? "full" : "open";
const publicOwnerView = (r) => ({
  requestId: String(r._id), title: r.title, instructions: r.instructions || null, status: statusOf(r), createdByEmail: r.createdByEmail, createdAt: r.createdAt, expiresAt: r.expiresAt,
  maxFiles: r.maxFiles, received: r.received || 0, maxFileBytes: r.maxFileBytes, allowedExtensions: r.allowedExtensions || [], requireIdentity: r.requireIdentity, classification: r.classification || null,
  notifyOwner: !!r.notifyOwner, label: r.label || null, wrappedPrivateKey: r.wrappedPrivateKey, publicKeyJwk: r.publicKeyJwk,
});

// ------------------------------------------------------------------------------------------------ requester side

export async function createRequest({ orgId, actorEmail, input }) {
  const title = clean(input.title, LIMITS.titleMax); if (!title) fail(400, "A title is required.");
  if (!isValidPublicKeyJwk(input.publicKeyJwk)) fail(400, "A valid request key is required (generate it in the browser).");
  const wrapped = String(input.wrappedPrivateKey || ""); if (!wrapped || wrapped.length > LIMITS.wrappedKeyMax) fail(400, "The wrapped private key is required.");
  try { const w = JSON.parse(wrapped); if (w.v !== 1 || !w.ct || !w.salt || !w.iv) throw new Error("x"); } catch { fail(400, "The wrapped private key is not in the expected format."); }
  const ms = new Date(input.expiresAt).getTime();
  if (Number.isNaN(ms) || ms <= Date.now() || ms - Date.now() > LIMITS.expiryMaxDays * 86400_000) fail(400, `The request must expire in the future and within ${LIMITS.expiryMaxDays} days.`);
  const maxFiles = input.maxFiles === undefined ? LIMITS.maxFilesDefault : input.maxFiles;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > LIMITS.maxFilesMax) fail(400, `maxFiles must be between 1 and ${LIMITS.maxFilesMax}.`);
  const maxFileBytes = input.maxFileBytes === undefined ? LIMITS.fileBytesMax : input.maxFileBytes;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > LIMITS.fileBytesMax) fail(400, `maxFileBytes must be between 1 and ${LIMITS.fileBytesMax}.`);
  const allowed = [...new Set((input.allowedExtensions || []).map((e) => String(e).toLowerCase().replace(/^\./, "").trim()).filter(Boolean))];
  if (allowed.length > 50 || allowed.some((e) => !/^[a-z0-9]{1,12}$/.test(e))) fail(400, "allowedExtensions must be short file extensions such as pdf or docx.");
  const ri = { name: input.requireIdentity?.name !== false, email: input.requireIdentity?.email !== false, company: input.requireIdentity?.company === true };
  if (input.classification && !CLASSIFICATIONS.includes(input.classification)) fail(400, `classification must be one of ${CLASSIFICATIONS.join(", ")}.`);
  const token = randomBytes(32).toString("base64url");
  const { requests } = await cols();
  const doc = { orgId: toObjectId(orgId), createdByEmail: norm(actorEmail), createdAt: nowIso(), title, instructions: clean(input.instructions, LIMITS.instructionsMax) || null, expiresAt: new Date(ms).toISOString(), revokedAt: null,
    tokenHash: sha(token), maxFiles, maxFileBytes, allowedExtensions: allowed, requireIdentity: ri, classification: input.classification || null, notifyOwner: input.notifyOwner !== false, label: clean(input.label, 80) || null,
    publicKeyJwk: { kty: "EC", crv: "P-256", x: input.publicKeyJwk.x, y: input.publicKeyJwk.y }, wrappedPrivateKey: wrapped, received: 0 };
  const r = await requests.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "FILE_REQUEST", recordId: r.insertedId, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { maxFiles, expiresAt: doc.expiresAt, classification: doc.classification } });
  return { requestId: String(r.insertedId), token, request: publicOwnerView({ ...doc, _id: r.insertedId }) };
}

const canManage = (r, email, membership) => r.createdByEmail === norm(email) || canManageOrg(membership);
async function loadRequest(orgId, requestId) {
  let id; try { id = toObjectId(requestId); } catch { fail(404, "Request not found."); }
  const { requests } = await cols();
  const r = await requests.findOne({ _id: id, orgId: toObjectId(orgId) });
  if (!r) fail(404, "Request not found.");
  return r;
}

export async function listRequests({ orgId, actorEmail, membership, scope = "mine", status = null, limit = 50, before = null }) {
  const { requests } = await cols();
  const q = { orgId: toObjectId(orgId) };
  if (scope === "org") { if (!canManageOrg(membership)) fail(403, "Only the owner or an admin can see every request."); } else q.createdByEmail = norm(actorEmail);
  if (before) q.createdAt = { $lt: before };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const rows = await requests.find(q).sort({ createdAt: -1 }).limit(lim + 1).toArray();
  const more = rows.length > lim; if (more) rows.pop();
  let items = rows.map((r) => { const v = publicOwnerView(r); delete v.wrappedPrivateKey; return v; });
  if (status) items = items.filter((i) => i.status === status);
  return { items, nextCursor: more ? rows[rows.length - 1].createdAt : null };
}

/** The request with its uploads (metadata only) for the requester. The wrapped private key is included so the browser can open uploads. */
export async function getRequest({ orgId, requestId, actorEmail, membership }) {
  const r = await loadRequest(orgId, requestId);
  if (!canManage(r, actorEmail, membership)) fail(403, "You cannot see this request.");
  const { uploads } = await cols();
  const rows = await uploads.find({ requestId: String(r._id), status: "received" }).sort({ createdAt: -1 }).limit(200).toArray();
  return { ...publicOwnerView(r), uploads: rows.map((u) => ({ uploadId: String(u._id), uploaderName: u.uploaderName, uploaderEmail: u.uploaderEmail, uploaderCompany: u.uploaderCompany, note: u.note, ext: u.ext, size: u.size, partCount: u.partCount, receivedAt: u.receivedAt, keyEnvelope: u.keyEnvelope, ipMasked: u.ipMasked })) };
}

export async function revokeRequest({ orgId, requestId, actorEmail, membership }) {
  const r = await loadRequest(orgId, requestId);
  if (!canManage(r, actorEmail, membership)) fail(403, "You cannot manage this request.");
  const { requests, uploads, parts } = await cols();
  const res = await requests.findOneAndUpdate({ _id: r._id, revokedAt: null }, { $set: { revokedAt: nowIso(), revokedByEmail: norm(actorEmail) } });
  // Uploads still in progress are discarded; completed uploads stay for the requester to collect.
  const pending = await uploads.find({ requestId: String(r._id), status: "uploading" }).project({ _id: 1 }).toArray();
  if (pending.length) { await parts.deleteMany({ uploadId: { $in: pending.map((p) => String(p._id)) } }); await uploads.deleteMany({ _id: { $in: pending.map((p) => p._id) } }); }
  if (res) await logOrgActivity({ orgId, recordType: "FILE_REQUEST", recordId: r._id, actorEmail, action: "REVOKED", previousState: null, newState: null, metadata: {} });
  return { revoked: true, alreadyRevoked: !res };
}

export async function readUploadPart({ orgId, requestId, uploadId, index, actorEmail, membership }) {
  const r = await loadRequest(orgId, requestId);
  if (!canManage(r, actorEmail, membership)) fail(403, "You cannot see this request.");
  const { uploads, parts } = await cols();
  const u = await uploads.findOne({ _id: toObjectId(uploadId), requestId: String(r._id), status: "received" });
  if (!u) fail(404, "Upload not found.");
  const i = parseInt(index, 10); if (!Number.isInteger(i) || i < 0 || i >= u.partCount) fail(400, "Invalid part index.");
  const row = await parts.findOne({ uploadId: String(u._id), index: i });
  if (!row) fail(404, "Upload not found.");
  return { index: i, partCount: u.partCount, size: u.size, data: Buffer.from(row.data.buffer).toString("base64") };
}

export async function deleteUpload({ orgId, requestId, uploadId, actorEmail, membership }) {
  const r = await loadRequest(orgId, requestId);
  if (!canManage(r, actorEmail, membership)) fail(403, "You cannot manage this request.");
  const { uploads, parts, requests } = await cols();
  const u = await uploads.findOneAndDelete({ _id: toObjectId(uploadId), requestId: String(r._id) });
  if (!u) fail(404, "Upload not found.");
  await parts.deleteMany({ uploadId: String(u._id) });
  if (u.status === "received") await requests.updateOne({ _id: r._id, received: { $gt: 0 } }, { $inc: { received: -1 } });
  await logOrgActivity({ orgId, recordType: "FILE_REQUEST", recordId: r._id, actorEmail, action: "UPLOAD_DELETED", previousState: null, newState: null, metadata: { uploadId } });
  return { deleted: true };
}

// ------------------------------------------------------------------------------------------------ uploader side (public)

async function byToken(token) {
  const { requests } = await cols();
  return requests.findOne({ tokenHash: sha(String(token || "")) });
}

/** What the upload page shows. Nothing about the organization's data; a dead link reveals only that it is dead. */
export async function publicInfo(token) {
  const r = await byToken(token);
  if (!r) fail(404, "This link is invalid.");
  const st = statusOf(r);
  if (st !== "open") return { status: st, error: st === "revoked" ? "This request has been closed." : st === "expired" ? "This request has expired." : "This request has received all the files it asked for." };
  const { orgs } = await cols();
  const org = await orgs.findOne({ _id: r.orgId }, { projection: { name: 1 } });
  return { branding: await (await import("../branding/branding.js")).publicBranding(r.orgId), status: "open", title: r.title, instructions: r.instructions, organization: org?.name || null, expiresAt: r.expiresAt, remaining: r.maxFiles - (r.received || 0), maxFileBytes: r.maxFileBytes, partBytes: LIMITS.partBytes,
    allowedExtensions: r.allowedExtensions, requireIdentity: r.requireIdentity, publicKeyJwk: r.publicKeyJwk, requestId: String(r._id) };
}

const maskIp = (ip) => { const s = String(ip || ""); return /^\d+\.\d+\.\d+\.\d+$/.test(s) ? s.replace(/\.\d+$/, ".0") : s.includes(":") ? s.split(":").slice(0, 3).join(":") + "::" : null; };

export async function beginUpload({ token, uploader = {}, ext, size, partCount, keyEnvelope, ip }) {
  const r = await byToken(token);
  if (!r) fail(404, "This link is invalid.");
  if (statusOf(r) !== "open") fail(410, "This request is no longer accepting files.");
  // The file is encrypted before it reaches us, so only metadata can be governed (the result says contentInspected: false).
  const gov = await governUpload({ orgId: r.orgId, actorEmail: String(uploader.email || "anonymous@external"), role: "external", source: "file_request", filename: `upload.${String(ext || "bin")}`, size, ip, path: `file-requests/${r._id}` });
  if (!gov.allowed) fail(403, gov.message || "This upload is not allowed by the organization's policy.");
  const hr = await slidingWindowCheck({ action: "freq:hour", key: `${r._id}:${ip || "?"}`, max: LIMITS.uploadsPerHourPerIp, windowMs: 3600_000 });
  const day = await slidingWindowCheck({ action: "freq:day", key: `${ip || "?"}`, max: LIMITS.uploadsPerDayPerIp, windowMs: 86400_000 });
  if (!hr.allowed || !day.allowed) fail(429, "Too many uploads from this network. Try again later.");
  const name = clean(uploader.name, 100), email = norm(uploader.email).slice(0, 200), company = clean(uploader.company, 100), note = clean(uploader.note, 500);
  if (r.requireIdentity.name && !name) fail(400, "Please tell us your name.");
  if (r.requireIdentity.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "Please enter a valid email address.");
  if (r.requireIdentity.company && !company) fail(400, "Please tell us your company.");
  const extension = String(ext || "").toLowerCase().replace(/^\./, "");
  if (extension && !/^[a-z0-9]{1,12}$/.test(extension)) fail(400, "That file type is not accepted.");
  if (r.allowedExtensions.length) { if (!r.allowedExtensions.includes(extension)) fail(400, `Only these file types are accepted: ${r.allowedExtensions.join(", ")}.`, { code: "TYPE_NOT_ALLOWED" }); }
  else if (RISKY_EXTENSIONS.has(extension)) fail(400, "This kind of file cannot be sent through a file request.", { code: "TYPE_NOT_ALLOWED" });
  if (!Number.isInteger(size) || size < 1) fail(400, "The file is empty.");
  // size is the CIPHERTEXT size: plaintext plus a small fixed overhead (header, GCM tag), so the limit applies to the ciphertext with that slack.
  if (size > r.maxFileBytes + 8192) fail(413, `Files can be at most ${Math.floor(r.maxFileBytes / 1048576)} MB.`, { code: "TOO_LARGE" });
  if (!Number.isInteger(partCount) || partCount < 1 || partCount !== Math.ceil(size / LIMITS.partBytes)) fail(400, "Invalid part count.");
  const env = String(keyEnvelope || ""); if (!env || env.length > LIMITS.envelopeMax) fail(400, "The encryption envelope is missing.");
  try { const e = JSON.parse(env); if (e.v !== 1 || !e.epk || !e.sealed || !e.iv || !e.fileIv) throw new Error("x"); } catch { fail(400, "The encryption envelope is not valid."); }
  const { uploads } = await cols();
  const inFlight = await uploads.countDocuments({ requestId: String(r._id), status: "uploading", createdAt: { $gt: new Date(Date.now() - 3600_000).toISOString() } });
  if (inFlight >= r.maxFiles * LIMITS.concurrentUploadsFactor) fail(429, "Too many uploads are in progress. Try again in a moment.");
  const uploadKey = randomBytes(24).toString("base64url");
  const ins = await uploads.insertOne({ requestId: String(r._id), orgId: String(r.orgId), status: "uploading", uploadKeyHash: sha(uploadKey), uploaderName: name || null, uploaderEmail: email || null, uploaderCompany: company || null, note: note || null,
    ext: extension || null, size, partCount, keyEnvelope: env, createdAt: nowIso(), ipMasked: maskIp(ip) });
  return { uploadId: String(ins.insertedId), uploadKey, partBytes: LIMITS.partBytes };
}

async function ownUpload(token, uploadId, uploadKey) {
  const r = await byToken(token); if (!r) fail(404, "This link is invalid.");
  let id; try { id = toObjectId(uploadId); } catch { fail(404, "Upload not found."); }
  const { uploads } = await cols();
  const u = await uploads.findOne({ _id: id, requestId: String(r._id), uploadKeyHash: sha(String(uploadKey || "")) });
  if (!u) fail(404, "Upload not found.");
  return { r, u };
}

export async function uploadPart({ token, uploadId, uploadKey, index, data }) {
  const { r, u } = await ownUpload(token, uploadId, uploadKey);
  if (u.status !== "uploading") fail(409, "This upload is already complete.");
  if (statusOf(r) === "revoked" || statusOf(r) === "expired") fail(410, "This request is no longer accepting files.");
  if (!Number.isInteger(index) || index < 0 || index >= u.partCount) fail(400, "Invalid part index.");
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(400, "Malformed part.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 1 || bytes.length > LIMITS.partBytes + 64) fail(413, "Part too large.");
  const { parts } = await cols();
  try { await parts.insertOne({ uploadId: String(u._id), index, data: new Binary(bytes), createdAt: new Date() }); }
  catch (err) { if (err?.code === 11000) return { index, duplicate: true }; throw err; }
  return { index };
}

export async function completeUpload({ token, uploadId, uploadKey }) {
  const { r, u } = await ownUpload(token, uploadId, uploadKey);
  if (u.status === "received") return { receiptId: String(u._id), receivedAt: u.receivedAt, duplicate: true };
  if (statusOf(r) === "revoked" || statusOf(r) === "expired") fail(410, "This request is no longer accepting files.");
  const { parts, uploads, requests } = await cols();
  const have = await parts.countDocuments({ uploadId: String(u._id) });
  if (have !== u.partCount) fail(409, `Upload incomplete: ${have} of ${u.partCount} parts received.`, { code: "INCOMPLETE" });
  const agg = await parts.aggregate([{ $match: { uploadId: String(u._id) } }, { $group: { _id: null, bytes: { $sum: { $binarySize: "$data" } } } }]).toArray();
  if (agg[0]?.bytes !== u.size) fail(409, "The uploaded size does not match.", { code: "SIZE_MISMATCH" });
  // Take a slot atomically: the request must still be open and under its file limit at this instant.
  const slot = await requests.findOneAndUpdate({ _id: r._id, revokedAt: null, expiresAt: { $gt: nowIso() }, $expr: { $lt: [{ $ifNull: ["$received", 0] }, "$maxFiles"] } }, { $inc: { received: 1 } }, { returnDocument: "after" });
  if (!slot) { await parts.deleteMany({ uploadId: String(u._id) }); await uploads.deleteOne({ _id: u._id }); fail(410, "This request has just received all the files it asked for."); }
  const receivedAt = nowIso();
  await uploads.updateOne({ _id: u._id }, { $set: { status: "received", receivedAt } }); // the key hash stays: it makes a repeated complete harmless
  await logOrgActivity({ orgId: r.orgId, recordType: "FILE_REQUEST", recordId: r._id, actorEmail: u.uploaderEmail || "external", action: "FILE_RECEIVED", previousState: null, newState: null, metadata: { uploadId: String(u._id), size: u.size, ext: u.ext } });
  if (r.notifyOwner) {
    try { const m = await import("../notify/router.js"); await m.notifyEvent({ orgId: r.orgId, event: "customer.upload", targetEmail: r.createdByEmail, title: "A file was received", body: `${u.uploaderName || u.uploaderEmail || "Someone"} sent a file to "${r.title}" (${slot.received} of ${slot.maxFiles}).`, link: "/business?view=fileRequests", sourceId: String(r._id), dedupeKey: `freq:${u._id}`, protectedContent: true }); } catch { /* the upload is recorded either way */ }
  }
  import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId: r.orgId, type: "file_request.received", eventId: String(u._id), data: { requestId: String(r._id), uploadId: String(u._id) } })).catch(() => {});
  emitFileEvent(r.orgId, "uploaded", { source: "file_request", requestId: String(r._id), uploadId: String(u._id), size: u.size ?? null });
  return { receiptId: String(u._id), receivedAt };
}

/** Housekeeping: uploads never completed within an hour are discarded (bounded per call). */
export async function sweepAbandonedUploads({ limit = 200 } = {}) {
  const { uploads, parts } = await cols();
  const old = await uploads.find({ status: "uploading", createdAt: { $lt: new Date(Date.now() - 3600_000).toISOString() } }).project({ _id: 1 }).limit(limit).toArray();
  if (!old.length) return { removed: 0 };
  await parts.deleteMany({ uploadId: { $in: old.map((o) => String(o._id)) } });
  await uploads.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  return { removed: old.length };
}
