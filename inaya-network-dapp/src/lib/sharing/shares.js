// src/lib/sharing/shares.js
//
// Secure Sharing 2.0 (Competitive Expansion SOW workstream B): the database side. Extends the existing `document_shares` collection
// (old v1 links keep working exactly as before through document-permissions.resolveShareAccess) with policy-enforced v2 links, adds the
// manager listing/delegation/revocation, and the access-session flow that serves CIPHERTEXT through Inaya so every rule can be enforced
// for every byte (see policy.js for the honest boundary). New collections: file_share_access_events, drm_sessions, share_email_codes.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { createNotification } from "../notifications.js";
import { logDocumentActivity } from "../document-workflow.js";
import { generateShareToken, hashShareToken } from "../document-permissions.js";
import { sendEmail } from "../email.js";
import { LIMITS, evaluateShareAccess, hashPassword, publicShareView, shareStatus, validateLinkOptions, verifyPassword, watermarkText, MEMBER_PERMISSIONS } from "./policy.js";

export class ShareError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
const fail = (status, message, extra) => { throw new ShareError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const normEmail = (e) => String(e || "").trim().toLowerCase();

/** Last octet / last 80 bits dropped: enough for "roughly where from" in an access log, not enough to identify a person. */
export function maskIp(ip) {
  const s = String(ip || "").trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/\.\d+$/, ".0");
  if (s.includes(":")) return s.split(":").slice(0, 3).join(":") + "::";
  return null;
}

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const events = c.db.collection("file_share_access_events");
  const sessions = c.db.collection("drm_sessions");
  const codes = c.db.collection("share_email_codes");
  if (!indexed) {
    await Promise.all([
      c.documentShares.createIndex({ orgId: 1, createdByEmail: 1, createdAt: -1 }),
      c.documentShares.createIndex({ orgId: 1, managerEmails: 1 }),
      c.documentShares.createIndex({ orgId: 1, documentId: 1, createdAt: -1 }),
      events.createIndex({ orgId: 1, shareId: 1, at: -1 }),
      events.createIndex({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 }),
      sessions.createIndex({ tokenHash: 1 }, { unique: true }),
      sessions.createIndex({ shareId: 1 }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      codes.createIndex({ shareId: 1, email: 1 }),
      codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
    indexed = true;
  }
  return { ...c, events, sessions, codes };
}

async function logEvent({ orgId, share, type, reason = null, ip = null, email = null, sessionId = null }) {
  try {
    const { events } = await cols();
    await events.insertOne({ orgId: String(orgId), shareId: String(share._id), documentId: String(share.documentId), type, reason, ipMasked: maskIp(ip), email: email ? normEmail(email) : null, sessionId, at: new Date() });
  } catch { /* the access log never blocks the request */ }
}

// ------------------------------------------------------------------------------------------------ creation

export async function createLinkShare({ orgId, documentId, actorEmail, expiresAt, options }) {
  const parsed = validateLinkOptions(options || {});
  if (parsed.errors) fail(400, parsed.errors.join(" "));
  const o = parsed.value;
  const { documentShares } = await cols();
  const token = generateShareToken();
  const doc = {
    orgId: toObjectId(orgId), documentId: toObjectId(documentId), tokenHash: hashShareToken(token),
    createdByEmail: normEmail(actorEmail), createdAt: nowIso(), expiresAt,
    maxUses: o.maxUses, useCount: 0, revokedAt: null,
    v: 2, kind: "link", permission: o.permission, oneTime: o.oneTime, maxDownloads: o.maxDownloads, downloadCount: 0,
    passwordHash: o.password ? await hashPassword(o.password) : null, passwordFailures: 0, lockedUntil: null,
    ipAllow: o.ipAllow, domainAllow: o.domainAllow, deviceBinding: o.deviceBinding, boundDeviceId: null,
    notifyOnAccess: o.notifyOnAccess, watermark: o.watermark, label: o.label, note: o.note, managerEmails: o.managerEmails, lastAccessAt: null,
  };
  const r = await documentShares.insertOne(doc);
  await logDocumentActivity({ organizationId: orgId, documentId, actorId: normEmail(actorEmail), action: "DOCUMENT_SHARE_CREATED", previousState: null, newState: null,
    metadata: { shareId: String(r.insertedId), v: 2, permission: o.permission, expiresAt, passwordProtected: !!o.password, ipRestricted: o.ipAllow.length > 0, domainRestricted: o.domainAllow.length > 0, oneTime: o.oneTime } });
  return { shareId: String(r.insertedId), token, share: publicShareView({ ...doc, _id: r.insertedId }) };
}

/** Share with a person who is already in the organization: an explicit document grant (the existing permission model), optionally
 *  expiring. Recorded with sharedVia so the manager lists it next to links. */
export async function createMemberShare({ orgId, documentId, actorEmail, targetEmail, permission, expiresAt = null, note = null }) {
  const level = MEMBER_PERMISSIONS[permission];
  if (!level) fail(400, `permission must be one of ${Object.keys(MEMBER_PERMISSIONS).join(", ")}.`);
  const target = normEmail(targetEmail);
  const { orgMembers, documentPermissions } = await cols();
  if (!(await orgMembers.findOne({ orgId: toObjectId(orgId), email: target, status: "active" }))) fail(404, "That person is not a member of this organization.");
  await documentPermissions.updateOne(
    { orgId: toObjectId(orgId), documentId: toObjectId(documentId), email: target },
    { $set: { level, grantedByEmail: normEmail(actorEmail), grantedAt: nowIso(), expiresAt: expiresAt || null, sharedVia: "share", note: note ? String(note).slice(0, 500) : null }, $setOnInsert: { orgId: toObjectId(orgId), documentId: toObjectId(documentId), email: target } },
    { upsert: true });
  await logDocumentActivity({ organizationId: orgId, documentId, actorId: normEmail(actorEmail), action: "DOCUMENT_PERMISSION_GRANTED", previousState: null, newState: null, metadata: { email: target, level, expiresAt: expiresAt || null, viaShare: true } });
  return { email: target, level, expiresAt: expiresAt || null };
}

// ------------------------------------------------------------------------------------------------ management

export const canManageShare = (share, email, membership) =>
  share.createdByEmail === normEmail(email) || (share.managerEmails || []).includes(normEmail(email)) || canManageOrg(membership);

async function loadShare(orgId, shareId) {
  let id; try { id = toObjectId(shareId); } catch { fail(404, "Share not found."); }
  const { documentShares } = await cols();
  const s = await documentShares.findOne({ _id: id, orgId: toObjectId(orgId) });
  if (!s) fail(404, "Share not found.");
  return s;
}

export async function listShares({ orgId, actorEmail, membership, scope = "byMe", documentId = null, status = null, limit = 50, before = null }) {
  const me = normEmail(actorEmail);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const c = await cols();
  const orgObj = toObjectId(orgId);

  if (scope === "withMe") {
    const grants = await c.documentPermissions.find({ orgId: orgObj, email: me, grantedByEmail: { $nin: [me, null] }, ...(before ? { grantedAt: { $lt: before } } : {}) }).sort({ grantedAt: -1 }).limit(lim + 1).toArray();
    const more = grants.length > lim; if (more) grants.pop();
    const docs = grants.length ? await c.orgDocuments.find({ _id: { $in: grants.map((g) => g.documentId) }, orgId: orgObj }).project({ filename: 1, sizeBytes: 1 }).toArray() : [];
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const now = Date.now();
    return {
      items: grants.filter((g) => byId.has(String(g.documentId))).map((g) => ({ kind: "member", documentId: String(g.documentId), filename: byId.get(String(g.documentId)).filename, level: g.level, grantedByEmail: g.grantedByEmail, grantedAt: g.grantedAt, expiresAt: g.expiresAt || null, status: g.expiresAt && new Date(g.expiresAt).getTime() <= now ? "expired" : "active" })),
      nextCursor: more ? grants[grants.length - 1].grantedAt : null,
    };
  }

  const q = { orgId: orgObj };
  if (scope === "org") { if (!canManageOrg(membership)) fail(403, "Only the owner or an admin can see every share in the organization."); }
  else if (scope === "document") { if (!documentId) fail(400, "documentId is required."); q.documentId = toObjectId(documentId); }
  else if (scope === "byMe") q.$or = [{ createdByEmail: me }, { managerEmails: me }];
  else fail(400, "scope must be byMe, withMe, org or document.");
  if (documentId && scope !== "document") q.documentId = toObjectId(documentId);
  const nowI = nowIso();
  if (status === "active") { q.revokedAt = null; q.expiresAt = { $gt: nowI }; }
  else if (status === "expired") { q.revokedAt = null; q.expiresAt = { $lte: nowI }; }
  else if (status === "revoked") q.revokedAt = { $ne: null };
  if (before) q.createdAt = { $lt: before };
  const rows = await c.documentShares.find(q).sort({ createdAt: -1 }).limit(lim + 1).toArray();
  const more = rows.length > lim; if (more) rows.pop();
  const docs = rows.length ? await c.orgDocuments.find({ _id: { $in: [...new Set(rows.map((r) => String(r.documentId)))].map(toObjectId) }, orgId: orgObj }).project({ filename: 1 }).toArray() : [];
  const names = new Map(docs.map((d) => [String(d._id), d.filename]));
  const now = Date.now();
  let items = rows.map((r) => ({ ...publicShareView(r, now), documentId: String(r.documentId), filename: names.get(String(r.documentId)) || null, canManage: canManageShare(r, me, membership) }));
  if (status === "exhausted") items = items.filter((i) => i.status === "exhausted");
  return { items, nextCursor: more ? rows[rows.length - 1].createdAt : null };
}

export async function revokeShare({ orgId, shareId, actorEmail, membership }) {
  const share = await loadShare(orgId, shareId);
  if (!canManageShare(share, actorEmail, membership)) fail(403, "You cannot manage this share.");
  const c = await cols();
  const r = await c.documentShares.findOneAndUpdate({ _id: share._id, revokedAt: null }, { $set: { revokedAt: nowIso(), revokedByEmail: normEmail(actorEmail) } }, { returnDocument: "after" });
  if (r) {
    await c.sessions.updateMany({ shareId: String(share._id), revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await logDocumentActivity({ organizationId: orgId, documentId: share.documentId, actorId: normEmail(actorEmail), action: "DOCUMENT_SHARE_REVOKED", previousState: null, newState: null, metadata: { shareId: String(share._id) } });
    await logEvent({ orgId, share, type: "REVOKED", email: actorEmail });
  }
  return { revoked: true, alreadyRevoked: !r };
}

export async function updateShare({ orgId, shareId, actorEmail, membership, patch }) {
  const share = await loadShare(orgId, shareId);
  if (!canManageShare(share, actorEmail, membership)) fail(403, "You cannot manage this share.");
  if (share.revokedAt) fail(409, "A revoked share cannot be changed.");
  const set = {};
  const ownerOrAdmin = share.createdByEmail === normEmail(actorEmail) || canManageOrg(membership);
  if (patch.label !== undefined) set.label = String(patch.label ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, LIMITS.labelMax) || null;
  if (patch.note !== undefined) set.note = String(patch.note ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, LIMITS.noteMax) || null;
  if (typeof patch.notifyOnAccess === "boolean") set.notifyOnAccess = patch.notifyOnAccess;
  if (patch.expiresAt !== undefined) {
    const ms = new Date(patch.expiresAt).getTime();
    if (Number.isNaN(ms) || ms <= Date.now() || ms - Date.now() > LIMITS.maxExpiryDays * 86400_000) fail(400, `expiresAt must be in the future and within ${LIMITS.maxExpiryDays} days.`);
    set.expiresAt = new Date(ms).toISOString();
  }
  if (patch.managerEmails !== undefined) {
    if (!ownerOrAdmin) fail(403, "Only the share's creator or an organization admin can change who manages it.");
    const parsed = validateLinkOptions({ managerEmails: patch.managerEmails }); if (parsed.errors) fail(400, parsed.errors.join(" "));
    set.managerEmails = parsed.value.managerEmails;
  }
  if (patch.password !== undefined) {
    if (patch.password === null || patch.password === "") { set.passwordHash = null; set.passwordFailures = 0; set.lockedUntil = null; }
    else { const parsed = validateLinkOptions({ password: patch.password }); if (parsed.errors) fail(400, parsed.errors.join(" ")); set.passwordHash = await hashPassword(parsed.value.password); set.passwordFailures = 0; set.lockedUntil = null; }
  }
  if (!Object.keys(set).length) fail(400, "Nothing to change.");
  const c = await cols();
  const updated = await c.documentShares.findOneAndUpdate({ _id: share._id, revokedAt: null }, { $set: set }, { returnDocument: "after" });
  await logDocumentActivity({ organizationId: orgId, documentId: share.documentId, actorId: normEmail(actorEmail), action: "DOCUMENT_SHARE_UPDATED", previousState: null, newState: null, metadata: { shareId: String(share._id), fields: Object.keys(set).filter((k) => k !== "passwordHash"), passwordChanged: "passwordHash" in set } });
  return publicShareView(updated);
}

export async function listAccessEvents({ orgId, shareId, actorEmail, membership, limit = 50, before = null }) {
  const share = await loadShare(orgId, shareId);
  if (!canManageShare(share, actorEmail, membership)) fail(403, "You cannot manage this share.");
  const { events } = await cols();
  const q = { orgId: String(orgId), shareId: String(share._id), ...(before ? { at: { $lt: new Date(before) } } : {}) };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = await events.find(q).sort({ at: -1 }).limit(lim + 1).toArray();
  const more = rows.length > lim; if (more) rows.pop();
  return { events: rows.map((e) => ({ type: e.type, reason: e.reason, ipMasked: e.ipMasked, email: e.email, at: e.at })), nextCursor: more ? rows[rows.length - 1].at : null };
}

// ------------------------------------------------------------------------------------------------ recipient side

async function shareByToken(token) {
  const { documentShares } = await cols();
  const s = await documentShares.findOne({ tokenHash: hashShareToken(String(token || "")) });
  return s || null;
}

let emailSender = async ({ to, subject, text }) => sendEmail({ to, subject, text, html: `<p>${text}</p>` });
/** Tests replace the sender; production uses src/lib/email.js (Resend). */
export function setShareEmailSender(fn) { emailSender = fn; }

/** Domain-restricted links: emails a 6-digit code to an address in an allowed domain. The answer never says whether the address was
 *  eligible. Sending depends on the email provider being configured; when it is not, the visitor is told it is not available. */
export async function requestShareCode({ token, email, ip }) {
  const share = await shareByToken(token);
  const generic = { sent: true };
  const em = normEmail(email);
  if (!share || share.v !== 2 || !share.domainAllow?.length || shareStatus(share) !== "active") return generic;
  const rl = await slidingWindowCheck({ action: "share:code", key: `${share._id}:${ip || "?"}`, max: 6, windowMs: 3600_000 });
  if (!rl.allowed) fail(429, "Too many codes requested. Try again later.");
  const domain = em.split("@")[1];
  if (!domain || !share.domainAllow.includes(domain)) return generic;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const c = await cols();
  await c.codes.deleteMany({ shareId: String(share._id), email: em });
  await c.codes.insertOne({ shareId: String(share._id), email: em, codeHash: sha(`${share._id}:${em}:${code}`), attempts: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) });
  try { await emailSender({ to: em, subject: "Your Inaya secure link code", text: `Your code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this message.` }); }
  catch { return { sent: false, error: "Email delivery is not available right now." }; }
  return generic;
}

async function emailCodeValid(share, email, code) {
  if (!email || !code) return false;
  const em = normEmail(email); const { codes } = await cols();
  const row = await codes.findOneAndUpdate({ shareId: String(share._id), email: em, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
  if (!row || row.codeHash !== sha(`${share._id}:${em}:${String(code).trim()}`)) return false;
  await codes.deleteOne({ _id: row._id }); // single use
  return true;
}

/**
 * Opens a v2 link: applies every rule, then (atomically) takes one use and creates a short-lived access session. Returns what the
 * viewer needs (never a storage pointer). Throws ShareError with { needs } when the visitor still has to supply something.
 */
export async function openShare({ token, password, email, code, ip, deviceId, userAgent }) {
  const rl = await slidingWindowCheck({ action: "share:open", key: `${sha(String(token || "")).slice(0, 16)}:${ip || "?"}`, max: 60, windowMs: 10 * 60_000 });
  if (!rl.allowed) fail(429, "Too many attempts. Try again later.");
  const share = await shareByToken(token);
  if (!share) fail(404, "This link is invalid.");
  if (share.v !== 2) fail(409, "This is a legacy link.", { legacy: true });
  const c = await cols();
  const em = email ? normEmail(email) : null;
  const emailVerified = share.domainAllow?.length && em ? await emailCodeValid(share, em, code) : false;
  let passwordChecked;
  if (share.passwordHash && password !== undefined && password !== null && password !== "") passwordChecked = await verifyPassword(password, share.passwordHash);
  const base = { ip, deviceId, email: em, emailVerified, passwordChecked };
  let verdict = evaluateShareAccess(share, base);
  if (verdict.wrongPassword) {
    const upd = await c.documentShares.findOneAndUpdate({ _id: share._id }, { $inc: { passwordFailures: 1 } }, { returnDocument: "after" });
    if (upd.passwordFailures >= LIMITS.passwordAttempts) await c.documentShares.updateOne({ _id: share._id }, { $set: { lockedUntil: new Date(Date.now() + LIMITS.lockMinutes * 60_000).toISOString(), passwordFailures: 0 } });
    await logEvent({ orgId: share.orgId, share, type: "PASSWORD_FAILED", ip, email: em });
  }
  if (!verdict.allow) {
    if (verdict.status !== 401 || verdict.wrongPassword) await logEvent({ orgId: share.orgId, share, type: "DENIED", reason: verdict.error.slice(0, 80), ip, email: em });
    fail(verdict.status, verdict.error, { needs: verdict.needs });
  }

  // Take one use atomically; the guards re-check revocation, expiry, the use limit and the device binding in the same write.
  const nowI = nowIso();
  const filter = {
    _id: share._id, revokedAt: null, expiresAt: { $gt: nowI },
    $and: [
      { $expr: { $or: [{ $eq: ["$maxUses", null] }, { $lt: ["$useCount", "$maxUses"] }] } },
      ...(share.deviceBinding === "first-use" ? [{ $or: [{ boundDeviceId: null }, { boundDeviceId: { $exists: false } }, { boundDeviceId: deviceId || "-" }] }] : []),
    ],
  };
  const set = { lastAccessAt: nowI, passwordFailures: 0 };
  if (share.deviceBinding === "first-use" && deviceId) set.boundDeviceId = deviceId;
  if (share.deviceBinding === "first-use" && !deviceId) fail(403, "This link cannot be opened from here.");
  const taken = await c.documentShares.findOneAndUpdate(filter, { $inc: { useCount: 1 }, $set: set }, { returnDocument: "after" });
  if (!taken) fail(410, "This link is no longer available.");

  const doc = await c.orgDocuments.findOne({ _id: share.documentId, orgId: share.orgId });
  if (!doc) fail(404, "The shared document no longer exists.");
  const sessionToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Math.min(Date.now() + LIMITS.sessionMinutes * 60_000, new Date(taken.expiresAt).getTime()));
  const wm = taken.watermark ? watermarkText({ email: em, ip: maskIp(ip) || ip, label: taken.label }) : null;
  const ins = await c.sessions.insertOne({ tokenHash: sha(sessionToken), shareId: String(share._id), orgId: String(share.orgId), documentId: String(share.documentId), mode: taken.permission, watermark: wm, deviceId: deviceId || null, ipMasked: maskIp(ip), email: em, createdAt: new Date(), expiresAt, downloadCounted: false });
  await logEvent({ orgId: share.orgId, share, type: "OPENED", ip, email: em, sessionId: String(ins.insertedId) });
  await logDocumentActivity({ organizationId: share.orgId, documentId: share.documentId, actorId: "external", action: "DOCUMENT_SHARE_ACCESSED", metadata: { shareId: String(share._id), v: 2 } });
  if (taken.notifyOnAccess) {
    try { await createNotification({ scope: "org", orgId: share.orgId, targetEmail: share.createdByEmail, category: "external_share", type: "share.accessed", title: "Your secure link was opened", body: `${doc.filename} was opened${em ? ` by ${em}` : ""}.`, sourceModule: "sharing", sourceId: String(share._id), actionUrl: "/business?view=shares", metadata: {}, dedupeKey: `share:open:${ins.insertedId}` }); } catch { /* best effort */ }
  }
  return { sessionToken, expiresAt: expiresAt.toISOString(), filename: doc.filename, sizeBytes: doc.sizeBytes, permission: taken.permission, watermark: wm, label: taken.label, note: taken.note, parts: ["alpha", "beta"] };
}

const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/"];
let shardFetcher = async (cid) => {
  if (!/^[A-Za-z0-9]{40,100}$/.test(String(cid))) throw new Error("bad cid");
  let last;
  for (const g of GATEWAYS) {
    try { const res = await fetch(g + cid, { signal: AbortSignal.timeout(15000), redirect: "error" }); if (res.ok) return await res.text(); last = new Error(`gateway ${res.status}`); } catch (e) { last = e; }
  }
  throw last || new Error("no gateway");
};
/** Tests replace the fetcher; production reads the encrypted shard from an IPFS gateway on the recipient's behalf. */
export function setShardFetcher(fn) { shardFetcher = fn; }

/**
 * Serves one CIPHERTEXT shard of the shared document to a holder of a valid access session. Everything is re-checked on every fetch:
 * revocation, expiry, IP range, session validity, and (for download links) the download limit, which is reserved atomically on the
 * session's first fetch.
 */
export async function readShareContent({ token, sessionToken, part, ip }) {
  if (part !== "alpha" && part !== "beta") fail(400, "part must be alpha or beta.");
  const share = await shareByToken(token);
  if (!share || share.v !== 2) fail(404, "This link is invalid.");
  const c = await cols();
  const session = sessionToken ? await c.sessions.findOne({ tokenHash: sha(sessionToken), shareId: String(share._id) }) : null;
  if (!session || session.revokedAt || session.expiresAt <= new Date()) fail(401, "Your access has expired. Open the link again.");
  // Content fetches re-check revocation, expiry, IP range and device only. The use/download limits were consumed when the session was
  // opened (and the download reserved on the first fetch), so a session already holding its last allowed use may finish its fetches.
  const verdict = evaluateShareAccess({ ...share, passwordHash: null, domainAllow: [], maxUses: null, maxDownloads: null, lockedUntil: null }, { ip, deviceId: session.deviceId });
  if (!verdict.allow) fail(verdict.status, verdict.error);
  if (share.revokedAt) { fail(410, "This link has been revoked."); }
  if (share.permission === "download" && !session.downloadCounted) {
    const reserved = await c.documentShares.findOneAndUpdate(
      { _id: share._id, revokedAt: null, $expr: { $or: [{ $eq: ["$maxDownloads", null] }, { $lt: [{ $ifNull: ["$downloadCount", 0] }, "$maxDownloads"] }] } },
      { $inc: { downloadCount: 1 } }, { returnDocument: "after" });
    if (!reserved) fail(410, "This link has reached its download limit.");
    await c.sessions.updateOne({ _id: session._id }, { $set: { downloadCounted: true } });
    await logEvent({ orgId: share.orgId, share, type: "DOWNLOAD", ip, email: session.email, sessionId: String(session._id) });
  }
  const doc = await c.orgDocuments.findOne({ _id: share.documentId, orgId: share.orgId });
  if (!doc) fail(404, "The shared document no longer exists.");
  let content;
  try { content = await shardFetcher(part === "alpha" ? doc.cidAlpha : doc.cidBeta); } catch { fail(502, "The encrypted content could not be fetched right now. Try again."); }
  return { part, content };
}

/** What a visitor must provide to open a v2 link, without consuming a use or revealing anything about the document. Returns null for
 *  anything that is not a v2 link (the caller then follows the legacy flow). A dead link answers with its status only. */
export async function peekShare(token) {
  const share = await shareByToken(token);
  if (!share || share.v !== 2) return null;
  const st = shareStatus(share);
  if (st !== "active") return { v2: true, status: st, error: st === "revoked" ? "This link has been revoked." : st === "expired" ? "This link has expired." : "This link has reached its limit." };
  return { v2: true, status: "active", requires: { password: !!share.passwordHash, email: !!share.domainAllow?.length }, permission: share.permission, label: share.label || null };
}
