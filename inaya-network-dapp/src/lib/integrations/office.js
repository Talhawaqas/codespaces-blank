// src/lib/integrations/office.js
//
// Microsoft 365 / Office / Outlook integration (Competitive Expansion SOW workstream J: INTEGRATION-001, -002, -003).
//
// SOVEREIGN BY DEFAULT. Documents are encrypted in the person's own browser or desktop app, so the server never holds plaintext and cannot hand any to Microsoft.
// This module therefore never sends file content to Microsoft or any other service. What it provides:
//
//   Adapter       a provider-adapter description for Microsoft 365 (what it can do, what data flows where, and the REAL state of the organization's Microsoft connection,
//                 read from the existing integration catalog). Graph is used only for identity and metadata, only when connected, and the flow is stated in the product.
//   Edit session  "open in Word, Excel or PowerPoint" as a controlled lease: permission check, a file lock (existing locks), a short-lived edit authorization, a base
//                 version, renew, finish and abort. The client decrypts locally, launches the desktop Office app, re-encrypts on save and writes a NEW VERSION through the
//                 existing versions route; finishing is accepted only if that version really exists, was written by this person, and follows the base version.
//   Outlook       secure-link insertion: a policy-enforced link share made through the existing sharing engine, an HTML/text block with expiry and reminders, a management
//                 list (inspect, revoke) and a link inspector that never exposes the token.
//
// Honest limits: the desktop client that decrypts, launches Office and re-encrypts is the app's responsibility; this module is the control plane. Nothing here has been
// exercised against a live Microsoft 365 tenant or a real Outlook client.

import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { requireDocumentAccess } from "../document-permissions.js";
import { acquireLock, releaseLock, activeLock } from "../filelocks.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canManageOrg } from "../orgGates.js";

export class OfficeError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new OfficeError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const sha = (v) => createHash("sha256").update(String(v)).digest("hex");
const norm = (e) => String(e || "").trim().toLowerCase();

export const OFFICE_TYPES = { docx: "word", doc: "word", xlsx: "excel", xls: "excel", pptx: "powerpoint", ppt: "powerpoint" };
export const APP_SCHEMES = { word: "ms-word", excel: "ms-excel", powerpoint: "ms-powerpoint" };
export const SESSION_LEASE = { defaultMinutes: 30, maxMinutes: 8 * 60 };

async function cols() { const { db } = await getOrgCollections(); const sessions = db.collection("office_edit_sessions"); if (!cols.done) { await Promise.all([sessions.createIndex({ tokenHash: 1 }, { unique: true }), sessions.createIndex({ orgId: 1, documentId: 1, status: 1 }), sessions.createIndex({ orgId: 1, email: 1, startedAt: -1 })]); cols.done = true; } return { db, sessions }; }

// ------------------------------------------------------------------------------------------------ adapter
export const ADAPTERS = {
  microsoft365: {
    id: "microsoft365", label: "Microsoft 365",
    capabilities: [
      { id: "office_editing", label: "Edit in Word, Excel and PowerPoint", mode: "SOVEREIGN", note: "The file is decrypted on the person's own device, edited in the desktop Office app, and re-encrypted before it is saved as a new version. No file content goes to Microsoft." },
      { id: "outlook_links", label: "Secure links in Outlook", mode: "SOVEREIGN", note: "A policy-enforced Inaya link is inserted into the message. The recipient opens it in Inaya; the file is not attached or sent through Microsoft." },
      { id: "graph_identity", label: "Sign-in and identity (Entra ID)", mode: "METADATA", note: "Uses the existing Microsoft connection. Only the sign-in identity and basic profile are read." },
      { id: "graph_files", label: "OneDrive and SharePoint file metadata", mode: "METADATA", note: "Reads names and folders only where the connection grants it. File content is never downloaded from, or uploaded to, Microsoft by this integration." },
    ],
    neverDoes: ["Send plaintext document content to Microsoft", "Edit documents in Office on the web (that would require plaintext on Microsoft's servers)", "Store Microsoft credentials outside the existing encrypted integration store"],
    connectionProviders: ["microsoft_365", "outlook", "sharepoint", "entra_id"],
  },
};

export async function adapterStatus({ orgId }) {
  const { getOrgIntegrations } = await import("../integrations.js"); const a = ADAPTERS.microsoft365; let conns = [];
  try { const r = await getOrgIntegrations(orgId); conns = (r.integrations || r || []).filter((c) => a.connectionProviders.includes(c.providerId)); } catch { conns = []; }
  const configured = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
  return {
    adapter: a.id, label: a.label, platformAppRegistered: configured,
    connections: conns.map((c) => ({ providerId: c.providerId, state: c.state, lastSyncAt: c.lastSyncAt || null })),
    capabilities: a.capabilities.map((c) => ({ ...c, status: c.mode === "SOVEREIGN" ? "AVAILABLE" : !configured ? "NOT_CONFIGURED" : conns.some((x) => x.state === "ACTIVE") ? "AVAILABLE" : "NOT_CONNECTED" })),
    neverDoes: a.neverDoes, verified: "Not exercised against a live Microsoft 365 tenant or a real Outlook client.",
  };
}

// ------------------------------------------------------------------------------------------------ launching Office (pure)
/** The URI that asks the desktop Office app to open a file. Only https URLs and local file URIs are accepted, and only Office apps. */
export function buildLaunchUri({ app, fileUrl, mode = "edit" }) {
  const scheme = APP_SCHEMES[app]; if (!scheme) fail(400, `app must be one of ${Object.keys(APP_SCHEMES).join(", ")}.`);
  let u; try { u = new URL(String(fileUrl)); } catch { fail(400, "fileUrl is not a valid URL."); }
  if (!["https:", "file:"].includes(u.protocol)) fail(400, "Only https and local file URLs can be opened.");
  if (u.username || u.password) fail(400, "The URL must not contain credentials.");
  return `${scheme}:${mode === "view" ? "ofv" : "ofe"}|u|${u.href}`; // href is already percent-encoded
}

// ------------------------------------------------------------------------------------------------ edit sessions (J1 + J3)
const sessionView = (s) => ({ sessionId: String(s._id), documentId: String(s.documentId), filename: s.filename, app: s.app, email: s.email, status: s.status, startedAt: s.startedAt, expiresAt: s.expiresAt, baseVersion: s.baseVersion, newDocumentId: s.newDocumentId ? String(s.newDocumentId) : null, finishedAt: s.finishedAt || null });

export async function startEditSession({ orgId, membership, email, documentId, leaseMinutes = SESSION_LEASE.defaultMinutes }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "EDIT" }); if (access.error) fail(access.status, access.error);
  const doc = access.doc; const ext = String(doc.filename).split(".").pop().toLowerCase(); const app = OFFICE_TYPES[ext]; if (!app) fail(400, "Only Word, Excel and PowerPoint files can be opened this way.");
  const { orgDocuments } = await getOrgCollections(); const group = doc.documentGroupId || doc._id;
  const newer = await orgDocuments.findOne({ orgId: doc.orgId, documentGroupId: group, version: { $gt: doc.version || 1 }, deletedAt: null }, { projection: { _id: 1, version: 1 } });
  if (newer) fail(409, "This is not the latest version of the file. Open the latest version.", { latestVersionId: String(newer._id), code: "NOT_LATEST" });
  const lease = Math.min(Math.max(Number(leaseMinutes) || SESSION_LEASE.defaultMinutes, 1), SESSION_LEASE.maxMinutes);
  const lock = await acquireLock({ orgId, documentId, actorEmail: email, leaseMinutes: lease, reason: `Editing in ${app}` }); // 423 if someone else holds it
  const { sessions } = await cols(); const token = `ied_${randomBytes(24).toString("base64url")}`;
  const s = { _id: new ObjectId(), orgId: doc.orgId, documentId: doc._id, filename: doc.filename, app, email: norm(email), tokenHash: sha(token), startedAt: nowIso(), expiresAt: lock.expiresAt || new Date(Date.now() + lease * 60_000).toISOString(), baseVersion: doc.version || 1, baseFileHash: doc.fileHash, documentGroupId: group, status: "active", newDocumentId: null };
  await sessions.insertOne(s); await logOrgActivity({ orgId, recordType: "OFFICE_EDIT", recordId: s._id, actorEmail: email, action: "STARTED", previousState: null, newState: null, metadata: { documentId: String(doc._id), app, baseVersion: s.baseVersion, leaseMinutes: lease } });
  return { session: sessionView(s), editToken: token, note: "The token is shown once. It lets the helper renew, finish or abort this one session; it cannot read other files.", dataFlow: "File content is decrypted on this device and never sent to Microsoft." };
}

/** Authenticate a helper by its edit token. Returns the active session or throws. */
export async function sessionByToken({ sessionId, token }) {
  if (!/^[0-9a-f]{24}$/.test(String(sessionId || "")) || !String(token || "").startsWith("ied_")) fail(401, "A valid edit authorization is required.");
  const { sessions } = await cols(); const s = await sessions.findOne({ _id: new ObjectId(sessionId), tokenHash: sha(token) });
  if (!s) fail(401, "A valid edit authorization is required."); if (s.status !== "active") fail(409, `This edit session is ${s.status}.`, { code: "SESSION_" + s.status.toUpperCase() });
  if (new Date(s.expiresAt).getTime() <= Date.now()) { await sessions.updateOne({ _id: s._id, status: "active" }, { $set: { status: "expired" } }); fail(409, "This edit session has expired. Start a new one.", { code: "SESSION_EXPIRED" }); }
  return s;
}
const asMember = async (s) => { const { orgMembers } = await getOrgCollections(); return orgMembers.findOne({ orgId: s.orgId, email: s.email, status: "active" }); };

export async function renewSession({ sessionId, token, leaseMinutes = SESSION_LEASE.defaultMinutes }) {
  const s = await sessionByToken({ sessionId, token }); const lease = Math.min(Math.max(Number(leaseMinutes) || SESSION_LEASE.defaultMinutes, 1), SESSION_LEASE.maxMinutes);
  const m = await asMember(s); if (!m) fail(403, "This person is no longer a member of the organization.");
  const lock = await acquireLock({ orgId: String(s.orgId), documentId: String(s.documentId), actorEmail: s.email, leaseMinutes: lease, reason: `Editing in ${s.app}` });
  const { sessions } = await cols(); await sessions.updateOne({ _id: s._id }, { $set: { expiresAt: lock.expiresAt } }); return { sessionId: String(s._id), expiresAt: lock.expiresAt };
}
export async function abortSession({ sessionId, token }) {
  const s = await sessionByToken({ sessionId, token }); const { sessions } = await cols();
  await releaseLock({ orgId: String(s.orgId), documentId: String(s.documentId), actorEmail: s.email, membership: await asMember(s) }).catch(() => {});
  await sessions.updateOne({ _id: s._id }, { $set: { status: "aborted", finishedAt: nowIso() } }); await logOrgActivity({ orgId: String(s.orgId), recordType: "OFFICE_EDIT", recordId: s._id, actorEmail: s.email, action: "ABORTED", previousState: null, newState: null, metadata: { documentId: String(s.documentId) } });
  return { aborted: true, versionWritten: false };
}
/** The edit is complete only if the NEW VERSION really exists: written by this person, after the session began, directly after the base version, in the same document group. */
export async function finishSession({ sessionId, token, newDocumentId }) {
  const s = await sessionByToken({ sessionId, token }); if (!/^[0-9a-f]{24}$/.test(String(newDocumentId || ""))) fail(400, "newDocumentId is required: save the new version first.");
  const { orgDocuments } = await getOrgCollections(); const nv = await orgDocuments.findOne({ _id: new ObjectId(newDocumentId), orgId: s.orgId, deletedAt: null });
  if (!nv) fail(409, "That version was not found. Save the new version before finishing.", { code: "NO_NEW_VERSION" });
  const sameGroup = String(nv.documentGroupId || "") === String(s.documentGroupId); const next = (nv.version || 1) === s.baseVersion + 1; const mine = norm(nv.uploadedByEmail) === s.email; const after = new Date(nv.createdAt).getTime() >= new Date(s.startedAt).getTime() - 1000;
  if (!(sameGroup && next && mine && after) || String(nv._id) === String(s.documentId) || nv.fileHash === s.baseFileHash) fail(409, "That is not the new version of this file written during this session.", { code: "NOT_A_NEW_VERSION" });
  const { sessions } = await cols(); const m = await asMember(s);
  await releaseLock({ orgId: String(s.orgId), documentId: String(s.documentId), actorEmail: s.email, membership: m }).catch(() => {});
  await sessions.updateOne({ _id: s._id }, { $set: { status: "finished", finishedAt: nowIso(), newDocumentId: nv._id } });
  await logOrgActivity({ orgId: String(s.orgId), recordType: "OFFICE_EDIT", recordId: s._id, actorEmail: s.email, action: "FINISHED", previousState: null, newState: null, metadata: { documentId: String(s.documentId), newDocumentId: String(nv._id), newVersion: nv.version, app: s.app } });
  return { finished: true, newVersion: nv.version, newDocumentId: String(nv._id) };
}
/** The encrypted-content pointers for the document under edit (same data the app's own retrieve route returns), only while the session is active. */
export async function sessionContent({ sessionId, token }) {
  const s = await sessionByToken({ sessionId, token }); const { orgDocuments } = await getOrgCollections(); const d = await orgDocuments.findOne({ _id: s.documentId, orgId: s.orgId, deletedAt: null }); if (!d) fail(404, "Document not found.");
  await logOrgActivity({ orgId: String(s.orgId), recordType: "OFFICE_EDIT", recordId: s._id, actorEmail: s.email, action: "CONTENT_FETCHED", previousState: null, newState: null, metadata: { documentId: String(d._id) } }).catch(() => {});
  return { filename: d.filename, sizeBytes: d.sizeBytes, cidAlpha: d.cidAlpha, cidBeta: d.cidBeta, version: d.version || 1, encrypted: true, note: "Decrypt on this device with your passkey. The server never holds it." };
}
export async function listSessions({ orgId, membership, email, scope = "mine", limit = 50 }) {
  const { sessions } = await cols(); const q = { orgId: toObjectId(orgId) };
  if (scope === "org") { if (!canManageOrg(membership)) fail(403, "Only the owner or an admin can see every edit session."); } else q.email = norm(email);
  return { sessions: (await sessions.find(q).sort({ startedAt: -1 }).limit(Math.min(Number(limit) || 50, 200)).toArray()).map(sessionView) };
}
/** Sweeps sessions whose lease ran out: marks them expired (the lock expires on its own). Safe to run on a schedule. */
export async function expireSessions({ now = Date.now() } = {}) { const { sessions } = await cols(); const r = await sessions.updateMany({ status: "active", expiresAt: { $lte: new Date(now).toISOString() } }, { $set: { status: "expired" } }); return { expired: r.modifiedCount }; }

// ------------------------------------------------------------------------------------------------ Outlook (J2)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (iso) => new Date(iso).toUTCString().replace(/:\d\d GMT/, " UTC");
/** The block inserted into an e-mail. Escaped; a password is NEVER included (it is mentioned only as "sent separately"). */
export function buildLinkBlock({ url, filename, expiresAt, passwordProtected, restrictions = [], note = "" }) {
  const reminders = [`This link expires on ${when(expiresAt)}.`, passwordProtected ? "It is password protected. The password is shared separately, never in this message." : null, ...restrictions, "Each access is logged. Do not forward this link to people who should not have the file."].filter(Boolean);
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;border:1px solid #d0d7de;border-radius:8px;padding:12px;max-width:520px"><div style="font-weight:600">Secure file: ${esc(filename)}</div>${note ? `<p style="margin:6px 0">${esc(note)}</p>` : ""}<p style="margin:8px 0"><a href="${esc(url)}">Open the file securely</a></p><ul style="margin:6px 0;padding-left:18px;color:#57606a;font-size:12px">${reminders.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`;
  const text = [`Secure file: ${filename}`, note, `Open: ${url}`, ...reminders.map((r) => `- ${r}`)].filter(Boolean).join("\n");
  return { html, text, reminders };
}

export async function createOutlookLink({ orgId, membership, email, documentId, origin, expirationPreset, customExpiresAt, options = {}, note = "", ip = null }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "MANAGE" }); if (access.error) fail(access.status, access.error);
  const { resolveExpiresAt, SHARE_EXPIRATION_PRESETS } = await import("../document-permissions.js"); const expiresAt = resolveExpiresAt({ preset: expirationPreset, customExpiresAt });
  if (!expiresAt) fail(400, `expirationPreset must be one of ${Object.keys(SHARE_EXPIRATION_PRESETS).join(", ")}, or customExpiresAt must be a valid future date within one year.`);
  const { createLinkShare, ShareError } = await import("../sharing/shares.js"); let made; try { made = await createLinkShare({ orgId, documentId, actorEmail: email, expiresAt, options: { ...options, label: options.label || `Outlook: ${access.doc.filename}` }, role: membership.role, ip }); } catch (e) { if (e instanceof ShareError) fail(e.status, e.message); throw e; }
  const { documentShares } = await getOrgCollections(); await documentShares.updateOne({ _id: new ObjectId(made.shareId) }, { $set: { createdVia: "outlook" } });
  const url = `${String(origin).replace(/\/$/, "")}/business/share/${made.token}`; const restrictions = []; if (options.ipAllow?.length) restrictions.push("Access is limited to approved networks."); if (options.domainAllow?.length) restrictions.push(`Only people at ${options.domainAllow.join(", ")} can open it.`); if (options.oneTime) restrictions.push("It can be opened once.");
  const block = buildLinkBlock({ url, filename: access.doc.filename, expiresAt, passwordProtected: !!options.password, restrictions, note });
  await logOrgActivity({ orgId, recordType: "OUTLOOK_LINK", recordId: new ObjectId(made.shareId), actorEmail: email, action: "INSERTED", previousState: null, newState: null, metadata: { documentId: String(documentId), expiresAt, passwordProtected: !!options.password } });
  return { shareId: made.shareId, url, expiresAt, block };
}
export async function listOutlookLinks({ orgId, email, limit = 50 }) {
  const { documentShares, orgDocuments } = await getOrgCollections(); const rows = await documentShares.find({ orgId: toObjectId(orgId), createdByEmail: norm(email), createdVia: "outlook", v: 2 }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200)).toArray();
  const docs = rows.length ? await orgDocuments.find({ _id: { $in: rows.map((r) => r.documentId) } }).project({ filename: 1 }).toArray() : []; const names = new Map(docs.map((d) => [String(d._id), d.filename])); const now = Date.now();
  return { links: rows.map((r) => ({ shareId: String(r._id), filename: names.get(String(r.documentId)) || null, createdAt: r.createdAt, expiresAt: r.expiresAt, status: r.revokedAt ? "revoked" : new Date(r.expiresAt).getTime() <= now ? "expired" : r.maxUses && r.useCount >= r.maxUses ? "exhausted" : "active", opened: r.useCount || 0, passwordProtected: !!r.passwordHash, lastAccessAt: r.lastAccessAt || null })) };
}
/** Inspect a link someone pasted. Never returns the token, the document name or anything about the content. */
export async function inspectLink({ url }) {
  let token; try { const u = new URL(String(url)); const m = u.pathname.match(/\/business\/share\/([A-Za-z0-9_-]{20,100})$/); token = m?.[1]; } catch { token = null; } if (!token) fail(400, "That is not an Inaya secure link.");
  const { peekShare } = await import("../sharing/shares.js"); const p = await peekShare(token); if (!p) return { recognized: false, status: "unknown", note: "This link was not found." };
  const { documentShares } = await getOrgCollections(); const { hashShareToken } = await import("../document-permissions.js"); const row = await documentShares.findOne({ tokenHash: hashShareToken(token) }, { projection: { expiresAt: 1, passwordHash: 1, domainAllow: 1, ipAllow: 1, oneTime: 1, permission: 1 } });
  return { recognized: true, status: p.status, expiresAt: row?.expiresAt || null, passwordProtected: !!row?.passwordHash, restrictedToDomains: !!row?.domainAllow?.length, restrictedNetworks: !!row?.ipAllow?.length, oneTime: !!row?.oneTime, permission: row?.permission || null };
}
