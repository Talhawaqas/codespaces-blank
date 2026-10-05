// src/lib/support/portalRequests.js
//
// Customer portal requests (Competitive Expansion SOW workstream L, PORTAL-001). A staff member asks ONE external customer or vendor to do a small set of things, and the
// customer does them in the existing portal after the existing portal sign-in (magic link, bound to one organization):
//
//   upload    send requested files           (policy checks and malware scan as for tickets; stored encrypted through the support bucket)
//   download  collect a file staff released  (only this customer, only through this request)
//   form      complete a secure form         (answers are validated against the form and stored encrypted at rest)
//   ack       accept an NDA or policy        (the exact text is hashed; the acceptance records who, when, the typed name and the hash)
//
// A request has a status the customer can see (OPEN, IN_PROGRESS, COMPLETE, CANCELLED), a comment thread, and a history. External customers stay external: a portal user
// never becomes an organization member, and can only ever see requests addressed to their own e-mail address in the portal of the organization they signed in to.
//
// Limits: single-request uploads up to 4 MB per file (the platform's request size); larger files continue to use ticket attachments (chunked, up to 25 MB).

import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, normEmail, isEmail, toPlainText, newToken } from "./common.js";
import { screenFile, safeFilename, storeSupportObject, FILE_TYPES, BUCKET } from "./attachments.js";
import { getS3ObjectBody } from "../s3-compat/store.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { notifyCustomer, notifyStaff, emailBody, portalUrl } from "./notify.js";
import { logOrgActivity } from "../org-activity-log.js";
import { hasAdminRole } from "../orgGates.js";

export const KINDS = ["upload", "download", "form", "ack"];
export const FIELD_TYPES = ["text", "textarea", "select", "checkbox", "date", "email", "number"];
export const LIMITS = { items: 20, fields: 30, titleMax: 140, textMax: 20000, fileBytes: 4 * 1024 * 1024, filesPerItem: 10, comments: 200, events: 500, answerMax: 4000, openPerCustomer: 50 };
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const maskIp = (ip) => { const s = String(ip || ""); if (s.includes(".")) return s.split(".").slice(0, 3).join(".") + ".0"; if (s.includes(":")) return s.split(":").slice(0, 3).join(":") + "::"; return null; };

export const canManageRequests = (m, { read = false } = {}) => hasAdminRole(m, ["helpdeskAdmin"], { read }) || m?.supportRole === "manager" || m?.supportRole === "agent";

async function cols() {
  await ensureSupportIndexes(); const { db } = await getSupportCollections();
  const c = { db, requests: db.collection("supportPortalRequests"), files: db.collection("supportPortalRequestFiles") };
  if (!cols.done) { await Promise.all([c.requests.createIndex({ orgId: 1, customerEmail: 1, createdAt: -1 }), c.requests.createIndex({ orgId: 1, status: 1, createdAt: -1 }), c.files.createIndex({ orgId: 1, requestId: 1 })]); cols.done = true; }
  return c;
}
const oid = (id) => { if (!/^[0-9a-f]{24}$/.test(String(id || ""))) return null; return new ObjectId(String(id)); };
const log = (orgId, id, actorEmail, action, metadata = {}) => logOrgActivity({ orgId, recordType: "PORTAL_REQUEST", recordId: id, actorEmail, action, previousState: null, newState: null, metadata }).catch(() => {});
const event = (kind, actor, detail = {}) => ({ at: nowIso(), kind, actor, detail });

// ------------------------------------------------------------------------------------------------ validation
export function validateForm(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > LIMITS.fields) return fail(`A form needs 1 to ${LIMITS.fields} fields.`);
  const seen = new Set(); const out = [];
  for (const f of fields) {
    const key = String(f?.key || "").trim(); if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || seen.has(key)) return fail("Each field needs a unique key of lowercase letters, digits or underscores, starting with a letter.");
    if (!FIELD_TYPES.includes(f.type)) return fail(`Field type must be one of ${FIELD_TYPES.join(", ")}.`); seen.add(key);
    const label = toPlainText(f.label, 140).trim(); if (!label) return fail("Every field needs a label.");
    const o = { key, label, type: f.type, required: f.required === true };
    if (f.type === "select") { const opts = (Array.isArray(f.options) ? f.options : []).map((x) => toPlainText(x, 80).trim()).filter(Boolean); if (opts.length < 2 || opts.length > 30 || new Set(opts).size !== opts.length) return fail("A select needs 2 to 30 distinct options."); o.options = opts; }
    out.push(o);
  }
  return { fields: out };
}
export function validateAnswers(fields, values) {
  const v = values && typeof values === "object" && !Array.isArray(values) ? values : {}; const out = {}; const errors = {};
  for (const f of fields) {
    const raw = v[f.key]; const empty = raw === undefined || raw === null || raw === "" || raw === false && f.type !== "checkbox";
    if (f.type === "checkbox") { out[f.key] = raw === true; if (f.required && raw !== true) errors[f.key] = "This must be checked."; continue; }
    if (empty) { if (f.required) errors[f.key] = "This is required."; continue; }
    if (f.type === "number") { const n = Number(raw); if (!Number.isFinite(n) || Math.abs(n) > 1e12) errors[f.key] = "Enter a number."; else out[f.key] = n; }
    else if (f.type === "date") { const s = String(raw); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) errors[f.key] = "Enter a date as YYYY-MM-DD."; else out[f.key] = s; }
    else if (f.type === "email") { const s = String(raw).trim(); if (!isEmail(s)) errors[f.key] = "Enter an e-mail address."; else out[f.key] = s; }
    else if (f.type === "select") { if (!f.options.includes(String(raw))) errors[f.key] = "Choose one of the options."; else out[f.key] = String(raw); }
    else { const s = toPlainText(String(raw), LIMITS.answerMax); if (String(raw).length > LIMITS.answerMax) errors[f.key] = `At most ${LIMITS.answerMax} characters.`; else out[f.key] = s; }
  }
  for (const k of Object.keys(v)) if (!fields.some((f) => f.key === k)) errors[k] = "Unknown field.";
  return Object.keys(errors).length ? { errors } : { values: out };
}

// ------------------------------------------------------------------------------------------------ projections
const itemView = (it, { forCustomer, files, response }) => {
  const base = { itemId: it.itemId, kind: it.kind, title: it.title, instructions: it.instructions || null, required: it.required !== false, state: it.state, doneAt: it.doneAt || null };
  if (it.kind === "upload") return { ...base, accept: it.accept || [], maxFiles: it.maxFiles, files: files.filter((f) => f.itemId === it.itemId && f.direction === "in").map(fileView) };
  if (it.kind === "download") return { ...base, file: files.filter((f) => f.itemId === it.itemId && f.direction === "out").map(fileView)[0] || null, downloadedAt: it.downloadedAt || null };
  if (it.kind === "form") return { ...base, fields: it.fields, answered: it.state === "DONE", response: response ?? null, submittedAt: it.doneAt || null };
  return { ...base, text: it.text, textHash: it.textHash, acceptance: it.acceptance ? { name: it.acceptance.name, at: it.acceptance.at, email: it.acceptance.email, textHash: it.acceptance.textHash } : null };
};
const fileView = (f) => ({ fileId: String(f._id), filename: f.filename, sizeBytes: f.sizeBytes, at: f.at, by: f.by });
const reqView = (r, files, { forCustomer, responses = {} } = {}) => ({
  requestId: String(r._id), title: r.title, instructions: r.instructions || null, status: r.status, customerEmail: r.customerEmail, dueAt: r.dueAt || null, createdAt: r.createdAt, createdBy: forCustomer ? undefined : r.createdByEmail, completedAt: r.completedAt || null,
  progress: { done: r.items.filter((i) => i.required !== false && i.state === "DONE").length, required: r.items.filter((i) => i.required !== false).length },
  items: r.items.map((it) => itemView(it, { forCustomer, files, response: responses[it.itemId] })),
  comments: (r.comments || []).map((c) => ({ by: c.by, name: c.name || null, text: c.text, at: c.at })), history: (r.events || []).map((e) => ({ at: e.at, kind: e.kind, actor: forCustomer && e.actorKind === "staff" ? "Staff" : String(e.actor).replace(/^customer:/, ""), detail: e.detail })),
});
const decryptResponse = (it) => { if (!it.responseEnc) return null; try { return JSON.parse(decryptIntegrationSecret(it.responseEnc)); } catch { return null; } };

// ------------------------------------------------------------------------------------------------ staff side
export async function createRequest({ orgId, settings, membership, actorEmail, customerEmail, title, instructions = "", dueAt = null, items }) {
  if (!canManageRequests(membership)) return fail("Only support staff can create customer requests.", 403);
  const email = normEmail(customerEmail); if (!isEmail(email)) return fail("A valid customer e-mail address is required.");
  const t = toPlainText(title, LIMITS.titleMax).trim(); if (!t) return fail("A title is required.");
  if (!Array.isArray(items) || !items.length || items.length > LIMITS.items) return fail(`A request needs 1 to ${LIMITS.items} items.`);
  let due = null; if (dueAt) { const ms = Date.parse(dueAt); if (Number.isNaN(ms) || ms <= Date.now()) return fail("The due date must be in the future."); due = new Date(ms).toISOString(); }
  const c = await cols(); const oidOrg = toObjectId(orgId);
  if ((await c.requests.countDocuments({ orgId: oidOrg, customerEmail: email, status: { $in: ["OPEN", "IN_PROGRESS"] } })) >= LIMITS.openPerCustomer) return fail(`This customer already has ${LIMITS.openPerCustomer} open requests.`, 409);
  const out = []; let needsCrypto = false;
  for (const raw of items) {
    if (!KINDS.includes(raw?.kind)) return fail(`An item kind must be one of ${KINDS.join(", ")}.`);
    const it = { itemId: newToken(6), kind: raw.kind, title: toPlainText(raw.title, LIMITS.titleMax).trim(), instructions: toPlainText(raw.instructions || "", 2000).trim() || null, required: raw.required !== false, state: "PENDING" };
    if (!it.title) return fail("Every item needs a title.");
    if (raw.kind === "upload") { it.accept = [...new Set((Array.isArray(raw.accept) ? raw.accept : []).map((x) => String(x).toLowerCase().replace(/^\./, "")).filter((x) => FILE_TYPES[x]))]; it.maxFiles = Math.min(LIMITS.filesPerItem, Math.max(1, Number(raw.maxFiles) || 1)); }
    if (raw.kind === "form") { const v = validateForm(raw.fields); if (v.error) return v; it.fields = v.fields; needsCrypto = true; }
    if (raw.kind === "ack") { const text = toPlainText(raw.text, LIMITS.textMax).trim(); if (text.length < 20) return fail("The text to accept must be at least 20 characters."); it.text = text; it.textHash = sha(text); }
    out.push(it);
  }
  if (needsCrypto && !isIntegrationCryptoConfigured()) return fail("Secure forms need INTEGRATION_ENCRYPTION_KEY to be configured on this server.", 503);
  const doc = { _id: new ObjectId(), orgId: oidOrg, customerEmail: email, title: t, instructions: toPlainText(instructions, 4000).trim(), dueAt: due, status: "OPEN", createdByEmail: normEmail(actorEmail), createdAt: nowIso(), completedAt: null, items: out, comments: [], events: [event("CREATED", normEmail(actorEmail), { items: out.length })] };
  doc.events[0].actorKind = "staff"; await c.requests.insertOne(doc);
  await log(orgId, doc._id, actorEmail, "CREATED", { items: out.map((i) => i.kind), due });
  await notifyCustomer({ orgId, settings, to: { email }, type: "portal_request", title: `New request: ${t}`, body: doc.instructions || "You have been asked to provide some information.", dedupeKey: `preq:${doc._id}:new`, force: true,
    email: { subject: `Action needed: ${t}`, ...emailBody({ heading: t, message: `${doc.instructions || "You have been asked to complete a few items."}\n\n${out.length} item(s)${due ? `, due ${new Date(due).toDateString()}` : ""}.`, linkUrl: portalUrl(settings, "#requests"), linkLabel: "Open your requests" }) } });
  return { request: reqView(doc, [], { forCustomer: false }) };
}

export async function listRequests({ orgId, membership, status = null, customerEmail = null, limit = 50, before = null }) {
  if (!canManageRequests(membership, { read: true })) return fail("Only support staff can see customer requests.", 403);
  const c = await cols(); const q = { orgId: toObjectId(orgId) }; if (status) q.status = String(status); if (customerEmail) q.customerEmail = normEmail(customerEmail); if (before) q.createdAt = { $lt: before };
  const rows = await c.requests.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 100)).toArray();
  return { requests: rows.map((r) => ({ requestId: String(r._id), title: r.title, status: r.status, customerEmail: r.customerEmail, dueAt: r.dueAt, createdAt: r.createdAt, completedAt: r.completedAt, progress: { done: r.items.filter((i) => i.required !== false && i.state === "DONE").length, required: r.items.filter((i) => i.required !== false).length } })) };
}
async function load(c, orgId, id) { const _id = oid(id); if (!_id) return null; return c.requests.findOne({ _id, orgId: toObjectId(orgId) }); }
export async function getRequestStaff({ orgId, membership, requestId, actorEmail }) {
  if (!canManageRequests(membership, { read: true })) return fail("Only support staff can see customer requests.", 403);
  const c = await cols(); const r = await load(c, orgId, requestId); if (!r) return fail("Request not found.", 404);
  const files = await c.files.find({ orgId: r.orgId, requestId: r._id }).toArray(); const responses = {}; for (const it of r.items) if (it.kind === "form") responses[it.itemId] = decryptResponse(it);
  if (Object.values(responses).some(Boolean)) await log(orgId, r._id, actorEmail, "RESPONSES_VIEWED", {});
  return { request: reqView(r, files, { forCustomer: false, responses }) };
}
export async function cancelRequest({ orgId, membership, actorEmail, requestId, reason = "" }) {
  if (!canManageRequests(membership)) return fail("Only support staff can cancel a request.", 403);
  const c = await cols(); const r = await c.requests.findOneAndUpdate({ _id: oid(requestId) || undefined, orgId: toObjectId(orgId), status: { $in: ["OPEN", "IN_PROGRESS"] } }, { $set: { status: "CANCELLED", cancelledAt: nowIso() }, $push: { events: { ...event("CANCELLED", normEmail(actorEmail), { reason: toPlainText(reason, 200) }), actorKind: "staff" } } }, { returnDocument: "after" });
  if (!r) return fail("Request not found, or already finished.", 404); await log(orgId, r._id, actorEmail, "CANCELLED", {}); return { cancelled: true };
}
export async function staffComment({ orgId, settings, membership, actorEmail, requestId, text }) {
  if (!canManageRequests(membership)) return fail("Only support staff can comment.", 403); const t = toPlainText(text, 2000).trim(); if (!t) return fail("Write a comment first.");
  const c = await cols(); const r = await load(c, orgId, requestId); if (!r) return fail("Request not found.", 404); if ((r.comments || []).length >= LIMITS.comments) return fail("This request has reached its comment limit.", 409);
  await c.requests.updateOne({ _id: r._id }, { $push: { comments: { by: "staff", name: null, email: normEmail(actorEmail), text: t, at: nowIso() }, events: { ...event("COMMENT", normEmail(actorEmail), {}), actorKind: "staff" } } });
  await notifyCustomer({ orgId, settings, to: { email: r.customerEmail }, type: "portal_request", title: `Update on: ${r.title}`, body: t.slice(0, 300), dedupeKey: `preq:${r._id}:c:${Date.now()}`, email: { subject: `Update on: ${r.title}`, ...emailBody({ heading: r.title, message: t, linkUrl: portalUrl(settings, "#requests"), linkLabel: "Open your requests" }) } });
  return { ok: true };
}
/** Staff releases a file for a `download` item. Only the addressed customer can collect it, through this request. */
export async function releaseFile({ orgId, settings, membership, actorEmail, requestId, itemId, filename, buffer }) {
  if (!canManageRequests(membership)) return fail("Only support staff can release files.", 403);
  const c = await cols(); const r = await load(c, orgId, requestId); if (!r || r.status === "CANCELLED") return fail("Request not found.", 404); const it = r.items.find((x) => x.itemId === itemId && x.kind === "download"); if (!it) return fail("That item does not take a released file.", 404);
  const stored = await storeFile({ orgId, settings, request: r, itemId, filename, buffer, direction: "out", by: normEmail(actorEmail) }); if (stored.error) return stored;
  await c.requests.updateOne({ _id: r._id }, { $push: { events: { ...event("FILE_RELEASED", normEmail(actorEmail), { filename: stored.file.filename }), actorKind: "staff" } } });
  await notifyCustomer({ orgId, settings, to: { email: r.customerEmail }, type: "portal_request", title: `A file is ready: ${stored.file.filename}`, body: `Open "${r.title}" to download it.`, dedupeKey: `preq:${r._id}:rel:${stored.file.fileId}`, email: { subject: `A file is ready for you: ${r.title}`, ...emailBody({ heading: r.title, message: `A file (${stored.file.filename}) is ready for you to download.`, linkUrl: portalUrl(settings, "#requests"), linkLabel: "Open your requests" }) } });
  return stored;
}
export async function remind({ orgId, settings, membership, actorEmail, requestId }) {
  if (!canManageRequests(membership)) return fail("Only support staff can send reminders.", 403); const c = await cols(); const r = await load(c, orgId, requestId); if (!r || !["OPEN", "IN_PROGRESS"].includes(r.status)) return fail("Request not found, or already finished.", 404);
  const pending = r.items.filter((i) => i.required !== false && i.state !== "DONE").length;
  const n = await notifyCustomer({ orgId, settings, to: { email: r.customerEmail }, type: "portal_request", title: `Reminder: ${r.title}`, body: `${pending} item(s) still need your attention.`, dedupeKey: `preq:${r._id}:rem:${new Date().toISOString().slice(0, 13)}`, force: true, email: { subject: `Reminder: ${r.title}`, ...emailBody({ heading: r.title, message: `${pending} item(s) still need your attention.`, linkUrl: portalUrl(settings, "#requests"), linkLabel: "Open your requests" }) } });
  await c.requests.updateOne({ _id: r._id }, { $push: { events: { ...event("REMINDER_SENT", normEmail(actorEmail), {}), actorKind: "staff" } } }); return { reminded: n.created === true };
}

// ------------------------------------------------------------------------------------------------ files
async function storeFile({ orgId, settings, request, itemId, filename, buffer, direction, by }) {
  const c = await cols(); const name = safeFilename(filename); const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length > LIMITS.fileBytes) return fail(`A file can be at most ${LIMITS.fileBytes / 1048576} MB here.`, 413);
  const screened = await screenFile({ filename: name, buffer: buf, settings: { ...settings, attachments: { ...(settings?.attachments || {}), maxBytes: LIMITS.fileBytes } } }); if (screened.error) return fail(screened.error, screened.reasonCode === "SCAN_UNAVAILABLE" ? 503 : 400, { reasonCode: screened.reasonCode });
  const ext = name.split(".").pop().toLowerCase(); const doc = { _id: new ObjectId(), orgId: request.orgId, requestId: request._id, itemId, direction, filename: name, contentType: FILE_TYPES[ext] || "application/octet-stream", sizeBytes: buf.length, sha256: sha(buf), by, at: nowIso() };
  const key = `portal-requests/${request._id}/${doc._id}/${name}`;
  try { const obj = await storeSupportObject({ orgId, key, buffer: buf, contentType: doc.contentType, actorEmail: by }); doc.storage = { bucket: BUCKET, key, versionId: obj?.versionId || null }; }
  catch (e) { console.error("portal request storage failed:", String(e.message).slice(0, 120)); return fail("The file could not be stored right now. Please try again.", 502, { reasonCode: "STORAGE_FAILED" }); }
  await c.files.insertOne(doc); return { file: fileView(doc) };
}
/** viewer = { kind: "staff", membership } or { kind: "customer", user }. The object key always comes from our own record. */
export async function getFileForDownload({ orgId, requestId, fileId, viewer, actorEmail }) {
  const c = await cols(); const r = await load(c, orgId, requestId); const _id = oid(fileId); if (!r || !_id) return null; const f = await c.files.findOne({ _id, requestId: r._id, orgId: r.orgId }); if (!f?.storage) return null;
  if (viewer.kind === "staff") { if (!canManageRequests(viewer.membership, { read: true })) return null; }
  else { if (normEmail(viewer.user.email) !== r.customerEmail) return null; if (r.status === "CANCELLED") return null; }
  const obj = await getS3ObjectBody({ orgId: String(r.orgId), bucket: f.storage.bucket, key: f.storage.key, versionId: f.storage.versionId || undefined }); if (!obj) return null;
  await log(orgId, r._id, actorEmail || viewer.user?.email, "FILE_DOWNLOADED", { fileId: String(f._id), by: viewer.kind });
  if (viewer.kind === "customer" && f.direction === "out") await markDone(c, r, f.itemId, "customer:" + normEmail(viewer.user.email), { downloadedAt: nowIso() });
  return { filename: f.filename, contentType: f.contentType, buffer: obj.buffer };
}

// ------------------------------------------------------------------------------------------------ customer side
const mine = async (c, orgId, user, requestId) => { const r = await load(c, orgId, requestId); return r && r.customerEmail === normEmail(user.email) ? r : null; };
export async function listForCustomer({ orgId, user }) {
  const c = await cols(); const rows = await c.requests.find({ orgId: toObjectId(orgId), customerEmail: normEmail(user.email) }).sort({ createdAt: -1 }).limit(100).toArray();
  return { requests: rows.map((r) => ({ requestId: String(r._id), title: r.title, status: r.status, dueAt: r.dueAt, createdAt: r.createdAt, completedAt: r.completedAt, progress: { done: r.items.filter((i) => i.required !== false && i.state === "DONE").length, required: r.items.filter((i) => i.required !== false).length } })) };
}
export async function getForCustomer({ orgId, user, requestId }) {
  const c = await cols(); const r = await mine(c, orgId, user, requestId); if (!r) return fail("Request not found.", 404);
  const files = await c.files.find({ orgId: r.orgId, requestId: r._id }).toArray(); const responses = {}; for (const it of r.items) if (it.kind === "form" && it.state === "DONE") responses[it.itemId] = decryptResponse(it);
  return { request: reqView(r, files, { forCustomer: true, responses }) };
}
async function markDone(c, r, itemId, actor, extra = {}) {
  const res = await c.requests.findOneAndUpdate({ _id: r._id, status: { $in: ["OPEN", "IN_PROGRESS"] }, "items.itemId": itemId }, { $set: { ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`items.$.${k}`, v])), "items.$.state": "DONE", "items.$.doneAt": nowIso() }, $push: { events: { ...event("ITEM_DONE", actor, { itemId }), actorKind: actor.startsWith("customer:") ? "customer" : "staff" } } }, { returnDocument: "after" });
  if (!res) return null; const required = res.items.filter((i) => i.required !== false); const complete = required.length > 0 && required.every((i) => i.state === "DONE");
  const next = complete ? "COMPLETE" : "IN_PROGRESS";
  if (res.status !== next) { await c.requests.updateOne({ _id: res._id, status: { $in: ["OPEN", "IN_PROGRESS"] } }, { $set: { status: next, ...(complete ? { completedAt: nowIso() } : {}) }, $push: { events: { ...event(complete ? "COMPLETED" : "STARTED", actor, {}), actorKind: "system" } } }); if (complete) await staffDone(res); }
  return res;
}
const staffDone = (r) => notifyStaff({ orgId: r.orgId, emails: [r.createdByEmail], title: `Customer request complete: ${r.title}`, body: `${r.customerEmail} has completed every required item.`, dedupeKey: `preq:${r._id}:done`, type: "support" });

export async function customerUpload({ orgId, settings, user, requestId, itemId, filename, buffer }) {
  const c = await cols(); const r = await mine(c, orgId, user, requestId); if (!r || !["OPEN", "IN_PROGRESS"].includes(r.status)) return fail("Request not found, or no longer open.", 404);
  const it = r.items.find((x) => x.itemId === itemId && x.kind === "upload"); if (!it) return fail("That item does not take a file.", 404);
  const ext = safeFilename(filename).split(".").pop().toLowerCase(); if (it.accept?.length && !it.accept.includes(ext)) return fail(`This item accepts: ${it.accept.join(", ")}.`, 400);
  const have = await c.files.countDocuments({ requestId: r._id, itemId, direction: "in" }); if (have >= it.maxFiles) return fail(`At most ${it.maxFiles} file(s) for this item.`, 409);
  const stored = await storeFile({ orgId, settings, request: r, itemId, filename, buffer, direction: "in", by: normEmail(user.email) }); if (stored.error) return stored;
  await markDone(c, r, itemId, "customer:" + normEmail(user.email)); await c.requests.updateOne({ _id: r._id }, { $push: { events: { ...event("FILE_UPLOADED", "customer:" + normEmail(user.email), { filename: stored.file.filename, sizeBytes: stored.file.sizeBytes }), actorKind: "customer" } } });
  await log(orgId, r._id, user.email, "FILE_UPLOADED", { sizeBytes: stored.file.sizeBytes }); await notifyStaff({ orgId, emails: [r.createdByEmail], title: `File received: ${r.title}`, body: `${user.email} sent ${stored.file.filename}.`, dedupeKey: `preq:${r._id}:up:${stored.file.fileId}`, type: "support" });
  return stored;
}
export async function customerForm({ orgId, user, requestId, itemId, values }) {
  const c = await cols(); const r = await mine(c, orgId, user, requestId); if (!r || !["OPEN", "IN_PROGRESS"].includes(r.status)) return fail("Request not found, or no longer open.", 404);
  const it = r.items.find((x) => x.itemId === itemId && x.kind === "form"); if (!it) return fail("That item is not a form.", 404); if (it.state === "DONE") return fail("This form was already submitted.", 409);
  if (!isIntegrationCryptoConfigured()) return fail("Secure forms are not available right now.", 503);
  const v = validateAnswers(it.fields, values); if (v.errors) return fail("Some answers need fixing.", 400, { reasonCode: "FORM_INVALID", errors: v.errors });
  await c.requests.updateOne({ _id: r._id, "items.itemId": itemId }, { $set: { "items.$.responseEnc": encryptIntegrationSecret(JSON.stringify(v.values)) } });
  await markDone(c, r, itemId, "customer:" + normEmail(user.email)); await log(orgId, r._id, user.email, "FORM_SUBMITTED", { itemId, fields: Object.keys(v.values).length });
  await notifyStaff({ orgId, emails: [r.createdByEmail], title: `Form submitted: ${r.title}`, body: `${user.email} completed "${it.title}".`, dedupeKey: `preq:${r._id}:f:${itemId}`, type: "support" }); return { ok: true };
}
export async function customerAccept({ orgId, user, requestId, itemId, name, textHash, ip }) {
  const c = await cols(); const r = await mine(c, orgId, user, requestId); if (!r || !["OPEN", "IN_PROGRESS"].includes(r.status)) return fail("Request not found, or no longer open.", 404);
  const it = r.items.find((x) => x.itemId === itemId && x.kind === "ack"); if (!it) return fail("That item is not an agreement.", 404); if (it.state === "DONE") return fail("This was already accepted.", 409);
  if (textHash !== it.textHash) return fail("The text you were shown is not the current text. Reload and read it again.", 409, { reasonCode: "TEXT_CHANGED" });
  const typed = toPlainText(name, 120).trim(); if (typed.length < 2) return fail("Type your full name to accept.");
  const acceptance = { name: typed, email: normEmail(user.email), at: nowIso(), textHash: it.textHash, ipMasked: maskIp(ip) };
  await c.requests.updateOne({ _id: r._id, "items.itemId": itemId }, { $set: { "items.$.acceptance": acceptance } }); await markDone(c, r, itemId, "customer:" + normEmail(user.email));
  await log(orgId, r._id, user.email, "AGREEMENT_ACCEPTED", { itemId, textHash: it.textHash, ipMasked: acceptance.ipMasked }); await notifyStaff({ orgId, emails: [r.createdByEmail], title: `Agreement accepted: ${r.title}`, body: `${user.email} accepted "${it.title}".`, dedupeKey: `preq:${r._id}:a:${itemId}`, type: "support" }); return { ok: true, acceptance: { name: typed, at: acceptance.at, textHash: it.textHash } };
}
export async function customerComment({ orgId, user, requestId, text }) {
  const t = toPlainText(text, 2000).trim(); if (!t) return fail("Write a comment first."); const c = await cols(); const r = await mine(c, orgId, user, requestId); if (!r) return fail("Request not found.", 404);
  if (r.status === "CANCELLED") return fail("This request was cancelled.", 409); if ((r.comments || []).length >= LIMITS.comments) return fail("This request has reached its comment limit.", 409);
  await c.requests.updateOne({ _id: r._id }, { $push: { comments: { by: "customer", name: user.name || null, email: normEmail(user.email), text: t, at: nowIso() }, events: { ...event("COMMENT", "customer:" + normEmail(user.email), {}), actorKind: "customer" } } });
  await notifyStaff({ orgId, emails: [r.createdByEmail], title: `New comment: ${r.title}`, body: t.slice(0, 200), dedupeKey: `preq:${r._id}:cc:${Date.now()}`, type: "support" }); return { ok: true };
}
