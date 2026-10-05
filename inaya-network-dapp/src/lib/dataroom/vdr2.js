// src/lib/dataroom/vdr2.js
//
// Virtual Data Room 2.0 (Competitive Expansion SOW workstream K, VDR-001..003) as an EXTENSION of src/lib/external-data-room.js: the same rooms,
// magic-link identity, NDA gate, sessions and access log, with additive fields. A room becomes "v2" when settings are applied to it; rooms that
// never opt in behave exactly as before.
//
//   room.v2, room.settings   { watermark, defaultPermission: view|download, ipAllow[], sessionHours, requireDeviceBinding }
//   room.docSettings[]       { documentId, section, permission, locked, final, order }   (documentIds / documentSections stay in step)
//   room.visitorGroups[]     { name, emails[] }
//   invite/session meta      allowedSections (null = all), role (viewer|downloader), ipAllow[]
//
// Visitors never receive a storage pointer: the encrypted shards are fetched by Inaya through a short per-open "view" and handed over as
// ciphertext; decryption needs the document passkey the owner shares separately, and happens in the visitor's browser.
// Honest limits: view-only is a viewer mode, a downloader can keep what they decrypt, and revoking a visitor stops further access, it cannot
// recall what they already saw (documented on the room page).

import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId, hashToken, generateToken } from "../orgs.js";
import { canManageOrg, hasAdminRole } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ipMatchesAny, normalizeIp, isValidCidr } from "../net/cidr.js";
import { getRoomSession, recordRoomAccess } from "../external-data-room.js";
import { assertDlp } from "../governance/dlp.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { createNotification } from "../notifications.js";
import { fetchShard } from "../sharing/shares.js";
import { requireFeature } from "../featureFlags.js";

export class VdrError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new VdrError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const lower = (v) => String(v ?? "").trim().toLowerCase();
const PERMS = ["view", "download"]; const ROLES = ["viewer", "downloader"];
export const LIMITS = { viewMinutes: 30, batch: 200, invitesPerCall: 50, questionMax: 2000, signalsPerMinute: 30, sessionHoursMax: 24 * 90 };

let indexed = false;
async function cols() {
  const c = await getOrgCollections(); const questions = c.db.collection("data_room_questions"); const views = c.db.collection("data_room_views");
  if (!indexed) { await Promise.all([questions.createIndex({ roomId: 1, createdAt: -1 }), views.createIndex({ viewId: 1 }, { unique: true }), views.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })]); indexed = true; }
  return { c, questions, views };
}
const oid = (v) => { try { return toObjectId(v); } catch { fail(404, "Not found."); } };

async function managedRoom({ orgId, roomId, membership }) {
  const { c } = await cols();
  const room = await c.dataRooms.findOne({ _id: oid(roomId), orgId: toObjectId(orgId) }); if (!room) fail(404, "Room not found.");
  // Reuse the room type's own manage gate (audit/finance rooms keep their narrower owners); fall back to owner/admin.
  const { canManageFinancialEntities, canManageAudit } = await import("../orgGates.js");
  const ok = room.roomType === "audit" ? canManageAudit(membership) : room.roomType === "investor" || room.roomType === "diligence" ? canManageFinancialEntities(membership) : canManageOrg(membership);
  if (!ok && !hasAdminRole(membership, "vdrAdmin")) fail(403, "You don't have permission to manage this room.");
  return { c, room };
}
const audit = (orgId, room, actor, action, metadata = {}) => logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: room._id, actorEmail: actor, action, previousState: null, newState: null, metadata }).catch(() => {});

// ----------------------------------------------------------------------------------------------------------- settings
export async function applyRoomSettings({ orgId, roomId, membership, actorEmail, settings = {} }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); if (room.closedAt) fail(409, "This room is closed.");
  const ipAllow = (settings.ipAllow || []).map(String); if (ipAllow.some((x) => !isValidCidr(x))) fail(400, "ipAllow must list valid IP addresses or CIDR ranges.");
  const hours = settings.sessionHours == null ? 168 : Number(settings.sessionHours); if (!Number.isFinite(hours) || hours < 1 || hours > LIMITS.sessionHoursMax) fail(400, `sessionHours must be 1 to ${LIMITS.sessionHoursMax}.`);
  const defaultPermission = settings.defaultPermission || "view"; if (!PERMS.includes(defaultPermission)) fail(400, "defaultPermission must be view or download.");
  const next = { watermark: settings.watermark !== false, defaultPermission, ipAllow, sessionHours: hours, requireDeviceBinding: !!settings.requireDeviceBinding, ndaRequired: settings.ndaRequired ?? !!room.ndaRequired };
  const set = { v2: true, settings: next, ...(next.ndaRequired !== !!room.ndaRequired ? { ndaRequired: next.ndaRequired } : {}), ...(settings.ndaText != null ? { ndaText: String(settings.ndaText).slice(0, 8000) } : {}) };
  if (!room.docSettings) set.docSettings = (room.documentIds || []).map((id, i) => ({ documentId: id, section: (room.documentSections || []).find((s) => String(s.documentId) === String(id))?.section || null, permission: defaultPermission, locked: false, final: false, order: i }));
  if (settings.sections) set.sections = [...new Set(settings.sections.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50);
  await c.dataRooms.updateOne({ _id: room._id }, { $set: set });
  await audit(orgId, room, actorEmail, "VDR2_SETTINGS_APPLIED", { watermark: next.watermark, defaultPermission, ipRestricted: ipAllow.length > 0, ndaRequired: next.ndaRequired });
  return { ok: true, settings: next };
}

// ---------------------------------------------------------------------------------------------------------- documents
const docEntry = (room, id) => (room.docSettings || []).find((d) => String(d.documentId) === String(id));
async function saveDocs({ c, room, docs }) {
  await c.dataRooms.updateOne({ _id: room._id }, { $set: { docSettings: docs, documentIds: docs.map((d) => d.documentId), documentSections: docs.filter((d) => d.section).map((d) => ({ documentId: d.documentId, section: d.section })) } });
}
function needV2(room) { if (!room.v2) fail(409, "Apply Data Room 2.0 settings to this room first."); }

/** Add one or many documents. Each must exist in the org; sections must belong to the room; duplicates are skipped. */
export async function bulkAddDocuments({ orgId, roomId, membership, actorEmail, documentIds, section = null, permission = null }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); needV2(room); if (room.closedAt) fail(409, "This room is closed.");
  if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > LIMITS.batch) fail(400, `Choose 1 to ${LIMITS.batch} documents.`);
  if (section && room.sections?.length && !room.sections.includes(section)) fail(400, `"${section}" is not one of this room's sections.`);
  const perm = permission || room.settings.defaultPermission; if (!PERMS.includes(perm)) fail(400, "permission must be view or download.");
  const found = await c.orgDocuments.find({ _id: { $in: documentIds.map(oid) }, orgId: toObjectId(orgId), deletedAt: null }).project({ _id: 1 }).toArray();
  const have = new Set(found.map((d) => String(d._id))); const docs = [...(room.docSettings || [])]; const added = []; const missing = [];
  for (const id of documentIds.map(String)) { if (!have.has(id)) { missing.push(id); continue; } if (docEntry(room, id)) continue; docs.push({ documentId: oid(id), section, permission: perm, locked: false, final: false, order: docs.length }); added.push(id); }
  await saveDocs({ c, room, docs }); await audit(orgId, room, actorEmail, "DOCUMENTS_ADDED", { count: added.length, section });
  return { added: added.length, skipped: documentIds.length - added.length - missing.length, missing };
}
/** Change section/permission/lock/final for one or many documents. Locked or final-version documents keep their section and permission until unlocked. */
export async function updateDocuments({ orgId, roomId, membership, actorEmail, documentIds, patch }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); needV2(room);
  const docs = (room.docSettings || []).map((d) => ({ ...d })); const touched = []; const refused = [];
  for (const id of (documentIds || []).map(String)) {
    const d = docs.find((x) => String(x.documentId) === id); if (!d) { refused.push({ id, reason: "not in the room" }); continue; }
    const protectedDoc = d.locked || d.final;
    const wantsChange = patch.section !== undefined || patch.permission !== undefined;
    if (protectedDoc && wantsChange && patch.locked !== false && patch.final !== false) { refused.push({ id, reason: d.final ? "this is the final version" : "this document is locked" }); continue; }
    if (patch.section !== undefined) { if (patch.section && room.sections?.length && !room.sections.includes(patch.section)) { refused.push({ id, reason: "unknown section" }); continue; } d.section = patch.section || null; }
    if (patch.permission !== undefined) { if (!PERMS.includes(patch.permission)) fail(400, "permission must be view or download."); d.permission = patch.permission; }
    if (patch.locked !== undefined) d.locked = !!patch.locked; if (patch.final !== undefined) { d.final = !!patch.final; if (d.final) d.locked = true; }
    touched.push(id);
  }
  await saveDocs({ c, room, docs }); await audit(orgId, room, actorEmail, "DOCUMENTS_UPDATED", { count: touched.length, patch: Object.keys(patch) });
  return { updated: touched.length, refused };
}
export async function removeDocuments({ orgId, roomId, membership, actorEmail, documentIds }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); needV2(room);
  const ids = new Set((documentIds || []).map(String)); const refused = []; const keep = [];
  for (const d of room.docSettings || []) { if (!ids.has(String(d.documentId))) { keep.push(d); continue; } if (d.locked || d.final) { refused.push({ id: String(d.documentId), reason: d.final ? "this is the final version" : "this document is locked" }); keep.push(d); } }
  const removed = (room.docSettings || []).length - keep.length; await saveDocs({ c, room, docs: keep.map((d, i) => ({ ...d, order: i })) });
  await audit(orgId, room, actorEmail, "DOCUMENTS_REMOVED", { count: removed }); return { removed, refused };
}
/** Swap the pinned version of a document for a newer row. Refused for final or locked documents. Visitors always see exactly the pinned row. */
export async function replaceDocumentVersion({ orgId, roomId, membership, actorEmail, oldDocumentId, newDocumentId }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); needV2(room);
  const docs = (room.docSettings || []).map((d) => ({ ...d })); const d = docs.find((x) => String(x.documentId) === String(oldDocumentId)); if (!d) fail(404, "That document is not in the room.");
  if (d.final) fail(409, "This is the final version and cannot be replaced."); if (d.locked) fail(409, "This document is locked. Unlock it first.");
  const nw = await c.orgDocuments.findOne({ _id: oid(newDocumentId), orgId: toObjectId(orgId), deletedAt: null }, { projection: { _id: 1 } }); if (!nw) fail(404, "The new version was not found.");
  if (docs.some((x) => String(x.documentId) === String(newDocumentId))) fail(409, "The new version is already in the room.");
  d.documentId = nw._id; await saveDocs({ c, room, docs }); await audit(orgId, room, actorEmail, "DOCUMENT_VERSION_REPLACED", { from: String(oldDocumentId), to: String(newDocumentId) }); return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------- visitors
export async function saveVisitorGroup({ orgId, roomId, membership, actorEmail, name, emails }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); needV2(room);
  const list = [...new Set((emails || []).map(lower).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))].slice(0, 200); if (!name || !list.length) fail(400, "A group needs a name and at least one valid email.");
  const groups = (room.visitorGroups || []).filter((g) => g.name !== name); groups.push({ name: String(name).slice(0, 80), emails: list });
  await c.dataRooms.updateOne({ _id: room._id }, { $set: { visitorGroups: groups } }); await audit(orgId, room, actorEmail, "VISITOR_GROUP_SAVED", { name, size: list.length }); return { ok: true, size: list.length };
}
/** Invite several people (or a saved group) at once, each with the same scope. Returns one link token per person; the caller emails them. */
export async function inviteVisitors({ orgId, roomId, membership, actorEmail, emails = [], group = null, allowedSections = null, role = "viewer", expiresInHours = null, ipAllow = [] }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); needV2(room); if (room.closedAt) fail(409, "This room is closed.");
  if (!ROLES.includes(role)) fail(400, "role must be viewer or downloader.");
  const list = [...new Set([...(emails || []), ...((room.visitorGroups || []).find((g) => g.name === group)?.emails || [])].map(lower).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))];
  if (!list.length || list.length > LIMITS.invitesPerCall) fail(400, `Invite 1 to ${LIMITS.invitesPerCall} people.`);
  if (allowedSections && (!Array.isArray(allowedSections) || allowedSections.some((s) => room.sections?.length && !room.sections.includes(s)))) fail(400, "allowedSections must be sections of this room.");
  if ((ipAllow || []).some((x) => !isValidCidr(x))) fail(400, "ipAllow must list valid IP addresses or CIDR ranges.");
  const hours = Math.min(expiresInHours ?? room.settings.sessionHours, room.settings.sessionHours);
  const out = [];
  for (const email of list) {
    const token = generateToken();
    await c.dataRoomExternalMagicLinks.insertOne({ tokenHash: hashToken(token), orgId: toObjectId(orgId), roomId: room._id, externalEmail: email, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), usedAt: null, issuedByEmail: actorEmail, createdAt: nowIso(), sessionTtlMs: hours * 3600_000, allowedSections: allowedSections?.length ? allowedSections : null, role, ipAllow: ipAllow || [] });
    out.push({ email, token });
  }
  await audit(orgId, room, actorEmail, "VISITORS_INVITED", { count: out.length, role, sections: allowedSections?.length || "all", hours });
  return { invites: out };
}
export async function listVisitors({ orgId, roomId, membership }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership });
  const sessions = await c.dataRoomExternalSessions.find({ orgId: toObjectId(orgId), roomId: room._id }).sort({ createdAt: -1 }).limit(500).toArray();
  const links = await c.dataRoomExternalMagicLinks.find({ orgId: toObjectId(orgId), roomId: room._id, usedAt: null, expiresAt: { $gt: nowIso() } }).project({ externalEmail: 1, createdAt: 1 }).toArray();
  return { visitors: sessions.map((s) => ({ email: s.externalEmail, since: s.createdAt, expiresAt: s.expiresAt, ndaAcceptedAt: s.ndaAcceptedAt || null, role: s.role || "viewer", allowedSections: s.allowedSections || null, revoked: !!s.revokedAt })), pendingInvites: links.map((l) => ({ email: l.externalEmail, sentAt: l.createdAt })) };
}

// ------------------------------------------------------------------------------------------------ visitor: documents
function visitorMeta(session) { return { allowedSections: session.allowedSections || null, role: session.role || "viewer", ipAllow: session.ipAllow || [] }; }
const visibleDocs = (room, session) => (room.docSettings || []).filter((d) => !visitorMeta(session).allowedSections || (d.section && visitorMeta(session).allowedSections.includes(d.section)));

async function visitorRoom(token) {
  const session = await getRoomSession(token); if (!session) fail(401, "Your session is invalid or has expired.");
  const { c } = await cols(); const room = await c.dataRooms.findOne({ _id: session.roomId, orgId: session.orgId }); if (!room || room.closedAt) fail(401, "Your session is invalid or has expired.");
  if (!room.v2) fail(409, "This room does not use Data Room 2.0.");
  if (await requireFeature("FEATURE_DATA_ROOM_V2", String(session.orgId))) fail(404, "This room is not available.");
  return { session, room, c };
}
function networkOk(room, session, ip) {
  const lists = [room.settings?.ipAllow, session.ipAllow].filter((l) => l?.length); if (!lists.length) return true;
  const n = ip ? normalizeIp(ip) : null; return !!n && lists.every((l) => ipMatchesAny(n, l));
}

/** What a visitor may see: names, sizes, sections and what they may do. Never a storage pointer or an internal id beyond the document id. */
export async function listVisitorDocuments({ token, ip }) {
  const { session, room, c } = await visitorRoom(token);
  if (!networkOk(room, session, ip)) fail(403, "This room cannot be opened from your network.");
  const branding = await (await import("../branding/branding.js")).publicBranding(session.orgId);
  if (room.ndaRequired && !session.ndaAcceptedAt) return { ndaRequired: true, ndaText: room.ndaText || null, documents: [], room: { name: room.name }, branding };
  const entries = visibleDocs(room, session); const rows = await c.orgDocuments.find({ _id: { $in: entries.map((d) => d.documentId) }, orgId: session.orgId }).project({ filename: 1, sizeBytes: 1, createdAt: 1 }).toArray(); const byId = new Map(rows.map((r) => [String(r._id), r]));
  await recordRoomAccess({ session, action: "LIST_DOCUMENTS" });
  const role = session.role || "viewer";
  return { branding, room: { name: room.name, sections: room.sections || [], watermark: room.settings.watermark, ndaRequired: !!room.ndaRequired }, role, documents: entries.filter((e) => byId.has(String(e.documentId))).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((e) => { const r = byId.get(String(e.documentId)); return { id: String(e.documentId), filename: r.filename, size: r.sizeBytes ?? null, uploadedAt: r.createdAt || null, section: e.section, final: !!e.final, locked: !!e.locked, canDownload: e.permission === "download" && role === "downloader" }; }) };
}

/** Open one document: runs every check, records it, and returns a short-lived view id used to fetch the ciphertext parts. */
export async function openVisitorDocument({ token, documentId, ip, deviceId }) {
  const { session, room, c } = await visitorRoom(token);
  if (!networkOk(room, session, ip)) { await recordRoomAccess({ session, action: "DENIED_NETWORK", documentId }); fail(403, "This room cannot be opened from your network."); }
  if (room.ndaRequired && !session.ndaAcceptedAt) fail(403, "Accept the confidentiality terms first.");
  const entry = visibleDocs(room, session).find((d) => String(d.documentId) === String(documentId)); if (!entry) fail(404, "Document not found.");
  if (room.settings.requireDeviceBinding) {
    if (!deviceId) fail(403, "This room cannot be opened from here.");
    const bound = session.boundDeviceId; if (bound && bound !== deviceId) { await recordRoomAccess({ session, action: "DENIED_DEVICE", documentId }); fail(403, "This room is tied to the first device that opened it."); }
    if (!bound) await c.dataRoomExternalSessions.updateOne({ _id: session._id, boundDeviceId: { $exists: false } }, { $set: { boundDeviceId: deviceId } });
  }
  const doc = await c.orgDocuments.findOne({ _id: toObjectId(documentId), orgId: session.orgId }); if (!doc) fail(404, "Document not found.");
  const mode = entry.permission === "download" && (session.role || "viewer") === "downloader" ? "download" : "view";
  try { await assertDlp({ orgId: String(session.orgId), ctx: { email: session.externalEmail, role: "external", ip, action: mode === "download" ? "share_download" : "preview", resourceType: "document", resourceId: String(doc._id), classification: doc.classification || null, filename: doc.filename, size: doc.sizeBytes, shareType: "room", destinationType: "external", destinationDomain: lower(session.externalEmail).split("@")[1], source: "data_room" } }); }
  catch (e) { if (e?.name === "DlpBlocked") fail(403, e.message, { code: e.code }); throw e; }
  const { views } = await cols(); const viewId = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Math.min(Date.now() + LIMITS.viewMinutes * 60_000, new Date(session.expiresAt).getTime()));
  await views.insertOne({ viewId: hashToken(viewId), sessionId: session._id, orgId: session.orgId, roomId: room._id, documentId: doc._id, mode, email: session.externalEmail, expiresAt, createdAt: nowIso() });
  await recordRoomAccess({ session, action: mode === "download" ? "OPENED_DOWNLOADABLE" : "OPENED_VIEW_ONLY", documentId });
  const org = await c.orgs.findOne({ _id: session.orgId }, { projection: { name: 1 } });
  const stamp = nowIso().replace("T", " ").slice(0, 16) + " UTC";
  return { viewId, filename: doc.filename, size: doc.sizeBytes ?? null, mode, expiresAt: expiresAt.toISOString(), parts: ["alpha", "beta"], final: !!entry.final, watermark: room.settings.watermark ? { lines: [session.externalEmail, org?.name || "", stamp] } : null };
}
export async function readVisitorContent({ token, viewId, part }) {
  if (part !== "alpha" && part !== "beta") fail(400, "part must be alpha or beta.");
  const { session, room, c } = await visitorRoom(token); const { views } = await cols();
  const v = await views.findOne({ viewId: hashToken(String(viewId || "")) });
  if (!v || String(v.sessionId) !== String(session._id) || v.expiresAt <= new Date()) fail(401, "Your view has expired. Open the document again.");
  const doc = await c.orgDocuments.findOne({ _id: v.documentId, orgId: session.orgId }); if (!doc) fail(404, "Document not found.");
  let content; try { content = await fetchShard(part === "alpha" ? doc.cidAlpha : doc.cidBeta); } catch { fail(502, "The encrypted content could not be fetched right now. Try again."); }
  return { part, content };
}
/** Client-reported viewer events (capture-attempt signals, download clicks). Signals, not proof: the page says so. Rate limited. */
export async function recordViewerSignal({ token, viewId, type }) {
  const allowed = ["DOWNLOAD_CLICKED", "PRINT_ATTEMPT", "SCREENSHOT_KEY", "WINDOW_BLURRED", "COPY_BLOCKED", "VIEW_CLOSED"]; if (!allowed.includes(type)) fail(400, "Unknown event.");
  const { session } = await visitorRoom(token); const { views } = await cols(); const v = await views.findOne({ viewId: hashToken(String(viewId || "")) });
  if (!v || String(v.sessionId) !== String(session._id)) fail(404, "Unknown view.");
  const rl = await slidingWindowCheck({ action: "vdr:signal", key: String(session._id), max: LIMITS.signalsPerMinute, windowMs: 60_000 }); if (!rl.allowed) return { ok: true, dropped: true };
  await recordRoomAccess({ session, action: `SIGNAL_${type}`, documentId: String(v.documentId) }); return { ok: true };
}

// ----------------------------------------------------------------------------------------------------------- questions
export async function askQuestion({ token, documentId = null, text }) {
  const { session, room } = await visitorRoom(token); const t = String(text || "").trim(); if (!t || t.length > LIMITS.questionMax) fail(400, `Write a question of up to ${LIMITS.questionMax} characters.`);
  if (documentId && !visibleDocs(room, session).some((d) => String(d.documentId) === String(documentId))) fail(404, "Document not found.");
  const { questions } = await cols(); const rl = await slidingWindowCheck({ action: "vdr:question", key: String(session._id), max: 20, windowMs: 3600_000 }); if (!rl.allowed) fail(429, "You have asked a lot of questions. Try again later.");
  const q = { _id: new ObjectId(), orgId: session.orgId, roomId: room._id, asker: session.externalEmail, documentId: documentId ? oid(documentId) : null, text: t, status: "open", createdAt: nowIso(), answer: null };
  await questions.insertOne(q); await recordRoomAccess({ session, action: "QUESTION_ASKED", documentId });
  try { await createNotification({ scope: "org", orgId: String(session.orgId), targetEmail: room.createdByEmail, category: "collaboration", type: "dataroom.question", title: "A question in a data room", body: `${session.externalEmail} asked a question in “${room.name}”.`, sourceModule: "data-rooms", sourceId: String(q._id), actionUrl: "/business?view=dataRooms", metadata: {}, dedupeKey: `vdrq:${q._id}` }); } catch { /* best effort */ }
  return { questionId: String(q._id) };
}
/** A visitor sees only their own questions and the answers to them. */
export async function listMyQuestions({ token }) { const { session, room } = await visitorRoom(token); const { questions } = await cols(); const rows = await questions.find({ roomId: room._id, asker: session.externalEmail }).sort({ createdAt: -1 }).limit(100).toArray(); return { questions: rows.map((q) => ({ id: String(q._id), text: q.text, status: q.status, answer: q.answer?.text || null, answeredAt: q.answer?.at || null, createdAt: q.createdAt, documentId: q.documentId ? String(q.documentId) : null })) }; }
export async function listQuestions({ orgId, roomId, membership, status = null }) {
  const { room } = await managedRoom({ orgId, roomId, membership }); const { questions } = await cols();
  const rows = await questions.find({ roomId: room._id, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200).toArray();
  return { questions: rows.map((q) => ({ id: String(q._id), asker: q.asker, text: q.text, status: q.status, answer: q.answer || null, createdAt: q.createdAt, documentId: q.documentId ? String(q.documentId) : null })) };
}
export async function answerQuestion({ orgId, roomId, membership, actorEmail, questionId, text }) {
  const { room } = await managedRoom({ orgId, roomId, membership }); const { questions } = await cols(); const t = String(text || "").trim(); if (!t || t.length > LIMITS.questionMax) fail(400, "Write an answer.");
  const r = await questions.findOneAndUpdate({ _id: oid(questionId), roomId: room._id }, { $set: { status: "answered", answer: { text: t, by: actorEmail, at: nowIso() } } }, { returnDocument: "after" }); const q = r?.value ?? r; if (!q) fail(404, "Question not found.");
  await audit(orgId, room, actorEmail, "QUESTION_ANSWERED", { questionId }); return { ok: true };
}

// --------------------------------------------------------------------------------------------- timeline, health, evidence
export async function roomTimeline({ orgId, roomId, membership, limit = 200 }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership });
  const [activity, access] = await Promise.all([
    c.orgActivity.find({ orgId: toObjectId(orgId), recordType: "DATA_ROOM", recordId: room._id }).sort({ timestamp: -1 }).limit(limit).toArray(),
    c.dataRoomAccessLog.find({ orgId: toObjectId(orgId), roomId: room._id }).sort({ accessedAt: -1 }).limit(limit).toArray(),
  ]);
  const events = [...activity.map((a) => ({ at: a.timestamp, kind: "admin", who: a.actorEmail, what: a.action, detail: a.metadata || {} })), ...access.map((a) => ({ at: a.accessedAt, kind: "visitor", who: a.externalEmail, what: a.action, detail: a.documentId ? { documentId: String(a.documentId) } : {} }))].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, limit);
  return { events };
}
export async function roomHealth({ orgId, roomId, membership }) {
  const { c, room } = await managedRoom({ orgId, roomId, membership }); const sessions = await c.dataRoomExternalSessions.find({ orgId: toObjectId(orgId), roomId: room._id }).toArray();
  const live = sessions.filter((s) => !s.revokedAt && new Date(s.expiresAt) > new Date()); const soon = live.filter((s) => new Date(s.expiresAt) < new Date(Date.now() + 48 * 3600_000));
  const last = await c.dataRoomAccessLog.find({ orgId: toObjectId(orgId), roomId: room._id }).sort({ accessedAt: -1 }).limit(1).next(); const { questions } = await cols();
  const open = await questions.countDocuments({ roomId: room._id, status: "open" }); const docs = room.docSettings || [];
  const warnings = [];
  if (room.v2 && room.ndaRequired === false && live.length) warnings.push("Visitors have access and no confidentiality terms are required.");
  if (room.v2 && !room.settings.ipAllow?.length) warnings.push("No network restriction is set.");
  if (room.v2 && docs.some((d) => !d.section) && room.sections?.length) warnings.push("Some documents are not in a section, so section-limited visitors cannot see them.");
  if (soon.length) warnings.push(`${soon.length} visitor${soon.length === 1 ? "'s" : "s'"} access expires within 48 hours.`);
  if (open) warnings.push(`${open} question${open === 1 ? " is" : "s are"} waiting for an answer.`);
  return { status: room.closedAt ? "closed" : room.v2 ? "open" : "open (v1)", v2: !!room.v2, documents: docs.length || (room.documentIds || []).length, locked: docs.filter((d) => d.locked).length, final: docs.filter((d) => d.final).length, visitors: { total: sessions.length, active: live.length, revoked: sessions.filter((s) => s.revokedAt).length, ndaAccepted: sessions.filter((s) => s.ndaAcceptedAt).length, expiringSoon: soon.length }, openQuestions: open, lastActivityAt: last?.accessedAt || null, warnings };
}
/** Everything the v1 evidence export holds, plus the v2 settings, document controls, visitor scopes and question counts (no question text, no content). */
export async function v2EvidenceSection({ orgId, room }) {
  if (!room.v2) return null; const { c } = await cols(); const sessions = await c.dataRoomExternalSessions.find({ orgId: toObjectId(orgId), roomId: room._id }).toArray(); const { questions } = await cols();
  return { settings: room.settings, documents: (room.docSettings || []).map((d) => ({ documentId: String(d.documentId), section: d.section, permission: d.permission, locked: !!d.locked, final: !!d.final })), visitors: sessions.map((s) => ({ email: s.externalEmail, role: s.role || "viewer", allowedSections: s.allowedSections || null, ndaAcceptedAt: s.ndaAcceptedAt || null, expiresAt: s.expiresAt, revoked: !!s.revokedAt })), questions: { total: await questions.countDocuments({ roomId: room._id }), answered: await questions.countDocuments({ roomId: room._id, status: "answered" }) } };
}
