// src/lib/ops/jobs.js -- Manage Orders SOW sections 5-7: Work Orders (WO) and Repair Orders (RO).
//
// One record kind (ops_job) with `type` WO | RO and two SEPARATE state machines (SOW 5.3). Every transition is one
// atomic findOneAndUpdate filtered on the expected current status (the purchase-order-workflow.js pattern), validated
// and audited on the server. Parts never have their own ledger: reserve / consume / return go through inventory.js
// (reserveStock, recordStockMovement with an idempotency key, releaseStock). RO billing raises ONE invoice through the
// existing invoice engine (validateInvoiceLines + computeInvoiceTotals, the same path Sales Orders use), locked so it can
// never be raised twice; the ledger posts it like any other invoice.
import { getOrgCollections } from "../orgs.js";
import { canAccessFinance, canAccessDepartment } from "../orgGates.js";
import { recordStockMovement, reserveStock, releaseStock } from "../inventory.js";
import { validateInvoiceLines, computeInvoiceTotals } from "../documentAutomation/invoiceTerms.js";
import { isSupportedCurrency } from "../currency.js";
import {
  ccol, oid, sid, clean, fail, nowIso, K, PRIORITIES, opsAccess, can, opsRoleOf, allowedLocation, denyLocation, scopeFilter,
  nextRef, audit, notifyMember, isDate, iso, newId, getOpsSettings,
} from "./core.js";

export const WO_STATES = ["DRAFT", "AWAITING_APPROVAL", "READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD", "AWAITING_PARTS", "AWAITING_INSPECTION", "COMPLETED", "CLOSED", "CANCELLED"];
export const RO_STATES = ["DRAFT", "RECEIVED", "INSPECTION", "DIAGNOSIS", "ESTIMATE_PREPARED", "AWAITING_APPROVAL", "APPROVED", "AWAITING_PARTS", "READY", "SCHEDULED", "IN_REPAIR", "QUALITY_CHECK", "READY_FOR_COLLECTION", "COMPLETED", "INVOICED", "CLOSED", "CANCELLED"];
const TERMINAL = ["CLOSED", "CANCELLED"];
// Manager/advisor transitions. Technician work (start, pause, submit) lives in activity.js; scheduling in scheduler.js.
export const TRANSITIONS = {
  WO: {
    submit: { from: ["DRAFT"], to: "AWAITING_APPROVAL", need: "edit_job" },
    approve: { from: ["AWAITING_APPROVAL"], to: "READY", need: "approve" },
    reject: { from: ["AWAITING_APPROVAL"], to: "DRAFT", need: "approve", reason: true },
    hold: { from: ["READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS"], to: "ON_HOLD", need: "approve", reason: true },
    await_parts: { from: ["READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"], to: "AWAITING_PARTS", need: "edit_job" },
    release: { from: ["ON_HOLD", "AWAITING_PARTS"], to: "READY", need: "edit_job" },
    inspect_pass: { from: ["AWAITING_INSPECTION"], to: "COMPLETED", need: "approve" },
    inspect_fail: { from: ["AWAITING_INSPECTION"], to: "ASSIGNED", need: "approve", reason: true },
    close: { from: ["COMPLETED"], to: "CLOSED", need: "approve" },
    cancel: { from: WO_STATES.filter((s) => !TERMINAL.includes(s) && s !== "COMPLETED"), to: "CANCELLED", need: "approve", reason: true },
  },
  RO: {
    check_in: { from: ["DRAFT"], to: "RECEIVED", need: "edit_job" },
    inspect: { from: ["RECEIVED"], to: "INSPECTION", need: "edit_job" },
    diagnose: { from: ["RECEIVED", "INSPECTION"], to: "DIAGNOSIS", need: "edit_job" },
    await_parts: { from: ["APPROVED", "READY", "SCHEDULED", "IN_REPAIR"], to: "AWAITING_PARTS", need: "edit_job" },
    ready: { from: ["APPROVED", "AWAITING_PARTS"], to: "READY", need: "edit_job" },
    qc_pass: { from: ["QUALITY_CHECK"], to: "READY_FOR_COLLECTION", need: "approve" },
    qc_fail: { from: ["QUALITY_CHECK"], to: "SCHEDULED", need: "approve", reason: true },
    complete: { from: ["READY_FOR_COLLECTION"], to: "COMPLETED", need: "edit_job" },
    close: { from: ["INVOICED"], to: "CLOSED", need: "approve" },
    cancel: { from: RO_STATES.filter((s) => !TERMINAL.includes(s) && !["COMPLETED", "INVOICED"].includes(s)), to: "CANCELLED", need: "approve", reason: true },
  },
};

let ready = null;
export async function ensureOpsIndexes() {
  if (ready) return ready; const c = await ccol();
  ready = Promise.all([
    c.createIndex({ orgId: 1, opsKey: 1 }, { unique: true, partialFilterExpression: { opsKey: { $exists: true } }, name: "ops_key" }),
    c.createIndex({ orgId: 1, opsKey2: 1 }, { unique: true, partialFilterExpression: { opsKey2: { $exists: true } }, name: "ops_key2" }),
    c.createIndex({ orgId: 1, kind: 1, status: 1, updatedAt: -1 }, { partialFilterExpression: { opsDoc: true }, name: "ops_list" }),
    c.createIndex({ orgId: 1, kind: 1, assigneeEmails: 1, status: 1 }, { partialFilterExpression: { opsDoc: true }, name: "ops_assignee" }),
    c.createIndex({ orgId: 1, kind: 1, jobId: 1, at: 1 }, { partialFilterExpression: { opsDoc: true }, name: "ops_job_ref" }),
  ]).catch((e) => { ready = null; throw e; });
  return ready;
}

// ------------------------------------------------------------------ views
const isTech = (m) => opsRoleOf(m) === "technician";
export function jobView(j, { showCost = true, showCustomer = true } = {}) {
  return {
    id: sid(j._id), type: j.type, number: j.number, status: j.status, priority: j.priority, title: j.title, description: j.description, category: j.category,
    warehouseId: sid(j.warehouseId), departmentId: sid(j.departmentId), site: j.site || null, plannedStart: j.plannedStart, plannedEnd: j.plannedEnd, dueAt: j.dueAt, estMinutes: j.estMinutes,
    skills: j.skills || [], checklist: j.checklist || [], requireInspection: !!j.requireInspection, requireEvidence: !!j.requireEvidence,
    assignments: (j.assignments || []).filter((a) => a.active).map((a) => ({ email: a.email, lead: !!a.lead })), assignmentHistory: j.assignments || [],
    workers: j.workers || [], parts: (j.parts || []).map((p) => ({ ...p, productId: sid(p.productId), ...(showCost ? {} : { unitPrice: undefined, unitCost: undefined }) })),
    notes: (j.notes || []).filter((n) => showCost || !n.internal), evidence: (j.evidence || []).map((e) => ({ ...e, fileId: sid(e.fileId) })),
    contactId: showCustomer ? sid(j.contactId) : null, assetId: showCustomer ? sid(j.assetId) : null, customerName: showCustomer ? j.customerName || null : null,
    intake: showCustomer ? j.intake || null : null, diagnosis: j.diagnosis || null, estimateVersion: j.estimateVersion || null, approvedEstimateVersion: j.approvedEstimateVersion || null,
    pendingChangeOrder: !!j.pendingChangeOrder, qc: j.qc || null, inspection: j.inspection || null, completion: j.completion || null,
    poIds: (j.poIds || []).map(sid), invoiceId: sid(j.invoiceId), labourEstMinutes: j.estMinutes || null, estCost: showCost ? j.estCost || null : null,
    managerEmail: j.managerEmail, requestedBy: j.requestedBy, createdBy: j.createdBy, createdAt: j.createdAt, updatedAt: j.updatedAt, lastActivityAt: j.lastActivityAt || j.updatedAt,
    history: j.history || [], pmTemplateId: sid(j.pmTemplateId),
  };
}

/** Loads a job the caller may see: tenant + branch + (technicians) assignment. */
export async function loadJob({ orgId, membership, jobId }) {
  const c = await ccol(); const j = await c.findOne({ _id: oid(jobId), orgId: oid(orgId), kind: K.job });
  if (!j) return { error: "Order not found.", status: 404 };
  if (!allowedLocation(membership, sid(j.warehouseId))) return denyLocation();
  if (!can(membership, "view_all") && !(j.assigneeEmails || []).includes(membership.email)) return { error: "Order not found.", status: 404 };
  return { job: j };
}
const viewFor = (m, j) => jobView(j, { showCost: can(m, "costs"), showCustomer: !isTech(m) || (j.assigneeEmails || []).includes(m.email) });

export async function getJob({ orgId, membership, jobId }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r;
  const c = await ccol();
  const estimates = r.job.type === "RO" ? await c.find({ orgId: oid(orgId), kind: K.estimate, jobId: r.job._id }).sort({ version: 1 }).toArray() : [];
  const acts = await c.find({ orgId: oid(orgId), kind: K.act, jobId: r.job._id }).sort({ at: 1 }).limit(500).toArray();
  const asset = r.job.assetId && !isTech(membership) ? await c.findOne({ _id: r.job.assetId, orgId: oid(orgId), kind: K.asset }) : null;
  return {
    job: viewFor(membership, r.job),
    estimates: can(membership, "costs") || !isTech(membership) ? estimates.map(estimateView) : [],
    activity: acts.map((a) => ({ id: sid(a._id), type: a.type, email: a.email, at: a.at, reason: a.reason || null, note: a.note || null, source: a.source || null, correctionOf: sid(a.correctionOf) })),
    asset: asset ? assetView(asset) : null,
  };
}

/** Register list: filters q, type, status, warehouseId, assignee, priority, from, to; technicians only see their own jobs. */
export async function listJobs({ orgId, membership, type, status, warehouseId, assignee, priority, q, from, to, sort = "updated", limit = 50, skip = 0 }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d; await ensureOpsIndexes();
  const f = { orgId: oid(orgId), kind: K.job, ...scopeFilter(membership, "warehouseId") };
  if (type) f.type = type === "RO" ? "RO" : "WO";
  if (status) f.status = { $in: String(status).split(",").filter(Boolean) };
  if (warehouseId) { if (!allowedLocation(membership, warehouseId)) return denyLocation(); f.warehouseId = oid(warehouseId); }
  if (!can(membership, "view_all")) f.assigneeEmails = membership.email; else if (assignee) f.assigneeEmails = assignee === "none" ? { $size: 0 } : String(assignee).toLowerCase();
  if (priority) f.priority = priority;
  if (from || to) f.createdAt = { ...(from ? { $gte: iso(from) } : {}), ...(to ? { $lte: iso(to) } : {}) };
  if (q) { const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i"); f.$or = [{ number: rx }, { title: rx }, { customerName: rx }, { "intake.assetLabel": rx }]; }
  const s = { updated: { updatedAt: -1 }, created: { createdAt: -1 }, due: { dueAt: 1 }, priority: { priorityRank: -1, updatedAt: -1 }, status: { status: 1, updatedAt: -1 } }[sort] || { updatedAt: -1 };
  const c = await ccol(); const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const [rows, total] = await Promise.all([c.find(f).sort(s).skip(Math.max(Number(skip) || 0, 0)).limit(lim).toArray(), c.countDocuments(f)]);
  return { jobs: rows.map((j) => viewFor(membership, j)), total };
}

// ------------------------------------------------------------------ create / update
const rank = (p) => PRIORITIES.indexOf(p);
function cleanChecklist(list) {
  if (list === undefined) return undefined; if (!Array.isArray(list) || list.length > 60) return { error: "A checklist can have up to 60 steps." };
  return list.map((x) => ({ id: sid(x.id) || sid(newId()), text: clean(typeof x === "string" ? x : x.text, 200), required: typeof x === "object" ? x.required !== false : true, evidence: typeof x === "object" && !!x.evidence, done: false })).filter((x) => x.text);
}
async function validateBase({ orgId, membership, input, type }) {
  const title = clean(input.title, 160); if (title.length < 3) return fail("Give the order a short title (at least 3 characters).");
  const warehouseId = sid(input.warehouseId); if (!warehouseId) return fail("Choose the branch this order belongs to.");
  if (!allowedLocation(membership, warehouseId)) return denyLocation();
  const { warehouses } = await getOrgCollections(); if (!await warehouses.findOne({ _id: oid(warehouseId), orgId: oid(orgId) }, { projection: { _id: 1 } })) return fail("Branch not found.", 404);
  const priority = input.priority ? String(input.priority).toUpperCase() : "NORMAL"; if (!PRIORITIES.includes(priority)) return fail(`priority must be one of ${PRIORITIES.join(", ")}.`);
  for (const k of ["plannedStart", "dueAt"]) if (!isDate(input[k])) return fail(`${k} must be a date.`);
  const est = input.estMinutes === undefined || input.estMinutes === null || input.estMinutes === "" ? null : Number(input.estMinutes);
  if (est !== null && !(Number.isInteger(est) && est > 0 && est <= 100000)) return fail("Estimated duration must be whole minutes.");
  const checklist = cleanChecklist(input.checklist); if (checklist?.error) return fail(checklist.error);
  const skills = Array.isArray(input.skills) ? input.skills.slice(0, 20).map((s) => clean(s, 40).toLowerCase()).filter(Boolean) : [];
  let contact = null;
  if (input.contactId) { const { crmContacts } = await getOrgCollections(); contact = await crmContacts.findOne({ _id: oid(input.contactId), orgId: oid(orgId), deletedAt: null }, { projection: { name: 1 } }); if (!contact) return fail("Customer not found.", 404); }
  if (type === "RO" && !contact) return fail("A repair order needs a customer (from CRM).");
  let asset = null;
  if (input.assetId) { const c = await ccol(); asset = await c.findOne({ _id: oid(input.assetId), orgId: oid(orgId), kind: K.asset }); if (!asset) return fail("Asset not found.", 404); if (contact && asset.contactId && sid(asset.contactId) !== sid(contact._id)) return fail("That asset belongs to a different customer."); }
  if (input.departmentId && !canAccessDepartment(membership, input.departmentId)) return fail("You don't have access to that department.", 403);
  return { title, warehouseId, priority, est, checklist, skills, contact, asset };
}

export async function createJob({ orgId, membership, actorEmail, input = {} }) {
  const type = input.type === "RO" ? "RO" : "WO";
  const d = await opsAccess({ orgId, membership, need: type === "RO" ? "create_ro" : "create_wo" }); if (d) return d; await ensureOpsIndexes();
  const v = await validateBase({ orgId, membership, input, type }); if (v.error) return v;
  const settings = await getOpsSettings(orgId); const now = nowIso();
  const number = await nextRef(orgId, type);
  const doc = {
    orgId: oid(orgId), kind: K.job, opsDoc: true, opsKey: `job:${number}`, type, number, status: "DRAFT", priority: v.priority, priorityRank: rank(v.priority),
    title: v.title, description: clean(input.description, 4000), category: clean(input.category, 60) || (type === "RO" ? "Repair" : "General"),
    warehouseId: oid(v.warehouseId), departmentId: oid(input.departmentId), site: clean(input.site, 200) || null,
    plannedStart: iso(input.plannedStart), plannedEnd: null, dueAt: iso(input.dueAt), estMinutes: v.est, skills: v.skills, checklist: v.checklist || [],
    requireInspection: input.requireInspection === undefined ? settings.requireInspection : !!input.requireInspection, requireEvidence: !!input.requireEvidence,
    parts: [], assignments: [], assigneeEmails: [], workers: [], notes: [], evidence: [], poIds: [],
    contactId: v.contact?._id || null, customerName: v.contact?.name || null, assetId: v.asset?._id || null,
    estCost: input.estCost !== undefined && input.estCost !== "" ? Math.max(0, Number(input.estCost) || 0) : null,
    managerEmail: clean(input.managerEmail, 200).toLowerCase() || actorEmail, requestedBy: clean(input.requestedBy, 200) || actorEmail,
    intake: null, diagnosis: null, history: [{ to: "DRAFT", by: actorEmail, at: now }], createdBy: actorEmail, createdAt: now, updatedAt: now, lastActivityAt: now,
    pmTemplateId: oid(input.pmTemplateId), ...(input.pmKey ? { opsKey2: input.pmKey } : {}),
  };
  if (type === "RO") {
    const it = input.intake || {};
    doc.intake = {
      reportedIssue: clean(it.reportedIssue, 2000), accessories: clean(it.accessories, 500), condition: clean(it.condition, 1000), notes: clean(it.notes, 2000),
      holdingLocation: clean(it.holdingLocation, 120), expectedAt: iso(it.expectedAt), contactPreference: ["phone", "email", "sms", "whatsapp"].includes(it.contactPreference) ? it.contactPreference : null,
      assetLabel: v.asset ? assetLabel(v.asset) : clean(it.assetLabel, 160), receivedAt: null, receivedBy: null, acknowledgement: null,
    };
  }
  try { const r = await (await ccol()).insertOne(doc); doc._id = r.insertedId; }
  catch (e) { if (e?.code === 11000) return fail("This order was already created.", 409, "DUPLICATE"); throw e; }
  await audit({ orgId, actorEmail, recordType: type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: doc._id, action: `${type}_CREATED`, newState: "DRAFT", metadata: { number } });
  return { job: viewFor(membership, doc) };
}

const EDITABLE = ["title", "description", "category", "priority", "plannedStart", "dueAt", "estMinutes", "checklist", "skills", "site", "requireInspection", "requireEvidence", "estCost", "departmentId", "managerEmail"];
export async function updateJob({ orgId, membership, actorEmail, jobId, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "edit_job" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  if (TERMINAL.includes(j.status) || ["COMPLETED", "INVOICED"].includes(j.status)) return fail(`A ${j.status.toLowerCase()} order can't be edited.`, 409);
  const set = {};
  for (const k of EDITABLE) if (input[k] !== undefined) {
    if (k === "priority") { const p = String(input.priority).toUpperCase(); if (!PRIORITIES.includes(p)) return fail("Unknown priority."); set.priority = p; set.priorityRank = rank(p); }
    else if (["plannedStart", "dueAt"].includes(k)) { if (!isDate(input[k])) return fail(`${k} must be a date.`); set[k] = iso(input[k]); }
    else if (k === "estMinutes") { const n = input[k] === null || input[k] === "" ? null : Number(input[k]); if (n !== null && !(Number.isInteger(n) && n > 0)) return fail("Estimated duration must be whole minutes."); set[k] = n; }
    else if (k === "checklist") { const cl = cleanChecklist(input[k]); if (cl.error) return fail(cl.error); const old = new Map((j.checklist || []).map((x) => [x.id, x])); set[k] = cl.map((x) => (old.has(x.id) ? { ...old.get(x.id), text: x.text, required: x.required, evidence: x.evidence } : x)); }
    else if (k === "skills") set[k] = (Array.isArray(input[k]) ? input[k] : []).slice(0, 20).map((s) => clean(s, 40).toLowerCase()).filter(Boolean);
    else if (["requireInspection", "requireEvidence"].includes(k)) set[k] = !!input[k];
    else if (k === "estCost") set[k] = input[k] === null || input[k] === "" ? null : Math.max(0, Number(input[k]) || 0);
    else if (k === "departmentId") { if (input[k] && !canAccessDepartment(membership, input[k])) return fail("You don't have access to that department.", 403); set[k] = oid(input[k]); }
    else if (k === "title") { const t = clean(input[k], 160); if (t.length < 3) return fail("Title too short."); set[k] = t; }
    else set[k] = clean(input[k], k === "description" ? 4000 : 200);
  }
  if (!Object.keys(set).length) return fail("Nothing to change.");
  const now = nowIso(); const c = await ccol();
  const u = await c.findOneAndUpdate({ _id: j._id, orgId: j.orgId, status: j.status }, { $set: { ...set, updatedAt: now }, $push: { history: { change: Object.keys(set), by: actorEmail, at: now } } }, { returnDocument: "after" });
  if (!u) return fail("The order changed while you were editing it. Reload and try again.", 409);
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: `${j.type}_UPDATED`, metadata: { fields: Object.keys(set) } });
  return { job: viewFor(membership, u) };
}

/** Manager / advisor status changes from the TRANSITIONS table. */
export async function transitionJob({ orgId, membership, actorEmail, jobId, action, reason }) {
  const r0 = await loadJob({ orgId, membership, jobId }); if (r0.error) return r0; const j = r0.job;
  const t = TRANSITIONS[j.type][action]; if (!t) return fail(`Unknown action "${action}" for a ${j.type === "RO" ? "repair" : "work"} order.`);
  const d = await opsAccess({ orgId, membership, need: t.need }); if (d) return d;
  if (!t.from.includes(j.status)) return fail(`This order is ${j.status.replace(/_/g, " ").toLowerCase()}; it can't be moved with "${action}".`, 409, "BAD_STATE");
  const why = clean(reason, 500); if (t.reason && why.length < 3) return fail("Give a reason.");
  if (action === "approve" && j.createdBy === actorEmail && opsRoleOf(membership) !== "manager") return fail("You can't approve your own order.", 403);
  if (j.type === "WO" && action === "inspect_pass" && j.requireEvidence && !(j.evidence || []).length) return fail("This order needs evidence (a photo or document) before it can pass inspection.", 409);
  const now = nowIso(); const extra = {};
  if (action === "inspect_pass" || action === "inspect_fail") extra.inspection = { result: action === "inspect_pass" ? "PASS" : "FAIL", by: actorEmail, at: now, note: why || null };
  if (action === "qc_pass" || action === "qc_fail") extra.qc = { result: action === "qc_pass" ? "PASS" : "FAIL", by: actorEmail, at: now, note: why || null };
  if (action === "check_in") { extra["intake.receivedAt"] = now; extra["intake.receivedBy"] = actorEmail; }
  if ((action === "inspect_fail" || action === "qc_fail") && (j.workers || []).length) extra["workers.$[].state"] = "NOT_STARTED";
  const c = await ccol();
  const u = await c.findOneAndUpdate({ _id: j._id, orgId: j.orgId, status: j.status }, { $set: { status: t.to, updatedAt: now, lastActivityAt: now, ...extra }, $push: { history: { from: j.status, to: t.to, action, by: actorEmail, at: now, reason: why || null } } }, { returnDocument: "after" });
  if (!u) return fail("The order changed at the same time. Reload and try again.", 409);
  if (t.to === "CANCELLED") await releaseAllReservations({ orgId, job: u, actorEmail });
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: `${j.type}_${action.toUpperCase()}`, previousState: j.status, newState: t.to, metadata: { reason: why || null } });
  if (["inspect_fail", "qc_fail"].includes(action)) for (const a of (u.assignments || []).filter((x) => x.active)) await notifyMember({ orgId, email: a.email, title: `${u.number} returned for rework`, body: "Your manager sent this job back. Open it to see the instructions.", type: "ops_rework", sourceId: u._id, dedupeKey: `ops:rework:${u._id}:${now}` });
  if (action === "cancel") for (const a of (u.assignments || []).filter((x) => x.active)) await notifyMember({ orgId, email: a.email, title: `${u.number} cancelled`, body: "This job was cancelled.", type: "ops_cancelled", sourceId: u._id, dedupeKey: `ops:cancel:${u._id}` });
  return { job: viewFor(membership, u) };
}

// ------------------------------------------------------------------ notes, checklist
export async function addNote({ orgId, membership, actorEmail, jobId, text, internal = false }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r;
  const t = clean(text, 4000); if (!t) return fail("Write a note first.");
  if (TERMINAL.includes(r.job.status)) return fail("This order is closed.", 409);
  const note = { id: sid(newId()), text: t, by: actorEmail, at: nowIso(), internal: !!internal && can(membership, "edit_job") };
  const c = await ccol(); await c.updateOne({ _id: r.job._id }, { $push: { notes: note }, $set: { updatedAt: note.at, lastActivityAt: note.at } });
  // Manager instructions reach the assigned technicians.
  if (can(membership, "edit_job") && !note.internal) for (const a of (r.job.assignments || []).filter((x) => x.active && x.email !== actorEmail)) await notifyMember({ orgId, email: a.email, title: `New instruction on ${r.job.number}`, body: "Your manager added a note to this job.", type: "ops_note", sourceId: r.job._id, dedupeKey: `ops:note:${note.id}:${a.email}` });
  return { note };
}
export async function tickChecklist({ orgId, membership, actorEmail, jobId, itemId, done, note }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  if (isTech(membership) && !(j.assigneeEmails || []).includes(actorEmail)) return fail("This job isn't assigned to you.", 403);
  if (TERMINAL.includes(j.status) || ["COMPLETED", "INVOICED"].includes(j.status)) return fail("This order is finished.", 409);
  const item = (j.checklist || []).find((x) => x.id === itemId); if (!item) return fail("Checklist step not found.", 404);
  const at = nowIso(); const c = await ccol();
  await c.updateOne({ _id: j._id, "checklist.id": itemId }, { $set: { "checklist.$.done": !!done, "checklist.$.by": actorEmail, "checklist.$.at": at, "checklist.$.note": clean(note, 500) || null, updatedAt: at, lastActivityAt: at } });
  return { ok: true };
}

// ------------------------------------------------------------------ parts (inventory.js is the only stock writer)
export async function addPart({ orgId, membership, actorEmail, jobId, productId, quantity, unitPrice, request = false }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  const asRequest = request || !can(membership, "edit_job");
  if (asRequest && isTech(membership) && !(j.assigneeEmails || []).includes(actorEmail)) return fail("This job isn't assigned to you.", 403);
  if (TERMINAL.includes(j.status) || ["COMPLETED", "INVOICED"].includes(j.status)) return fail("This order is finished.", 409);
  const q = Number(quantity); if (!(q > 0 && q <= 100000)) return fail("Quantity must be more than 0.");
  const { products } = await getOrgCollections(); const p = await products.findOne({ _id: oid(productId), orgId: oid(orgId) }, { projection: { name: 1, sku: 1, price: 1, unitPrice: 1, cost: 1, costPrice: 1 } });
  if (!p) return fail("Product not found.", 404);
  const line = { id: sid(newId()), productId: p._id, name: p.name, sku: p.sku || null, qty: q, reserved: 0, consumed: 0, returned: 0, unitPrice: unitPrice !== undefined && unitPrice !== "" && can(membership, "costs") ? Math.max(0, Number(unitPrice) || 0) : Number(p.unitPrice ?? p.price ?? 0) || 0, unitCost: Number(p.costPrice ?? p.cost ?? 0) || 0, requested: !!asRequest, requestedBy: asRequest ? actorEmail : null, approved: !asRequest, addedBy: actorEmail, at: nowIso() };
  const c = await ccol(); await c.updateOne({ _id: j._id }, { $push: { parts: line }, $set: { updatedAt: line.at, lastActivityAt: line.at } });
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: asRequest ? "OPS_PART_REQUESTED" : "OPS_PART_ADDED", metadata: { product: p.name, qty: q } });
  if (asRequest && j.managerEmail) await notifyMember({ orgId, email: j.managerEmail, title: `Parts requested on ${j.number}`, body: `${q} × ${p.name} requested by the technician.`, type: "ops_parts_request", sourceId: j._id, dedupeKey: `ops:partreq:${line.id}` });
  return { part: { ...line, productId: sid(line.productId) } };
}

/** action: approve (a technician request) | reserve | consume | return | release. qty optional (defaults to what's left). */
export async function partAction({ orgId, membership, actorEmail, jobId, partId, action, quantity, idempotencyKey }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  const p = (j.parts || []).find((x) => x.id === partId); if (!p) return fail("Part line not found.", 404);
  const techOwn = isTech(membership) && (j.assigneeEmails || []).includes(actorEmail);
  const parts = can(membership, "parts");
  if (action === "approve") { if (!can(membership, "edit_job") && !parts) return fail("Only a manager or storekeeper can approve a parts request.", 403); }
  else if (action === "consume") { if (!parts && !techOwn) return fail("Only the assigned technician, a storekeeper or a manager can record parts used.", 403); if (!p.approved) return fail("This parts request hasn't been approved yet.", 409); }
  else if (!parts) return fail("Only a storekeeper or manager can do this.", 403);
  if (TERMINAL.includes(j.status) && action !== "release") return fail("This order is closed.", 409);
  const c = await ccol(); const at = nowIso(); const key = clean(idempotencyKey, 80) || `${action}:${at}`;
  if (idempotencyKey && ["consume", "return"].includes(action)) {
    const { stockMovements } = await getOrgCollections();
    if (await stockMovements.findOne({ orgId: oid(orgId), idempotencyKey: `ops:${sid(j._id)}:${partId}:${action}:${key}` }, { projection: { _id: 1 } })) return { part: p, duplicate: true };
  }
  const left = { reserve: p.qty - p.reserved - p.consumed, consume: p.qty - p.consumed, return: p.consumed - p.returned, release: p.reserved };
  const q = quantity === undefined || quantity === null || quantity === "" ? left[action] : Number(quantity);
  if (action !== "approve" && !(q > 0)) return fail("Nothing left to do for this part.", 409);
  if (action !== "approve" && q > left[action]) return fail(`At most ${left[action]} can be used for "${action}" on this line.`, 409);
  const rec = { orgId, productId: sid(p.productId), warehouseId: sid(j.warehouseId), actorEmail };
  if (action === "approve") { await c.updateOne({ _id: j._id, "parts.id": partId }, { $set: { "parts.$.approved": true, "parts.$.approvedBy": actorEmail, "parts.$.approvedAt": at, updatedAt: at } }); }
  else if (action === "reserve") {
    const rs = await reserveStock({ ...rec, quantity: q, partial: false }); if (rs?.error) return fail(rs.error, 409);
    if (!(rs?.reserved >= q)) return fail(`Not enough free stock at this branch (free: ${rs?.free ?? 0}).`, 409, "NO_STOCK");
    await c.updateOne({ _id: j._id, "parts.id": partId }, { $inc: { "parts.$.reserved": q }, $set: { updatedAt: at } });
  } else if (action === "release") {
    try { await releaseStock({ ...rec, quantity: q }); } catch (e) { return fail(e.message || "Could not release the reservation.", 409); }
    await c.updateOne({ _id: j._id, "parts.id": partId }, { $inc: { "parts.$.reserved": -q }, $set: { updatedAt: at } });
  } else if (action === "consume") {
    const fromReserved = Math.min(p.reserved, q);
    const mv = await recordStockMovement({ ...rec, delta: -q, type: "CONSUME", consumeReserved: fromReserved, idempotencyKey: `ops:${sid(j._id)}:${partId}:consume:${key}`, note: `${j.number} parts used`, reason: j.number });
    if (mv?.error) return mv;
    if (!mv?.duplicate) await c.updateOne({ _id: j._id, "parts.id": partId }, { $inc: { "parts.$.consumed": q, "parts.$.reserved": -fromReserved }, $set: { updatedAt: at, lastActivityAt: at } });
  } else if (action === "return") {
    const mv = await recordStockMovement({ ...rec, delta: q, type: "RETURN", idempotencyKey: `ops:${sid(j._id)}:${partId}:return:${key}`, note: `${j.number} unused parts returned`, reason: j.number });
    if (mv?.error) return mv;
    if (!mv?.duplicate) await c.updateOne({ _id: j._id, "parts.id": partId }, { $inc: { "parts.$.returned": q }, $set: { updatedAt: at } });
  } else return fail("Unknown parts action.");
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: `OPS_PART_${action.toUpperCase()}`, metadata: { product: p.name, qty: q ?? null } });
  const fresh = await c.findOne({ _id: j._id });
  return { part: (fresh.parts || []).find((x) => x.id === partId) };
}
async function releaseAllReservations({ orgId, job, actorEmail }) {
  const c = await ccol();
  for (const p of job.parts || []) if (p.reserved > 0) {
    try { await releaseStock({ orgId, productId: sid(p.productId), warehouseId: sid(job.warehouseId), quantity: p.reserved, actorEmail }); } catch (e) { console.error("ops: release failed", e?.message); continue; }
    await c.updateOne({ _id: job._id, "parts.id": p.id }, { $set: { "parts.$.reserved": 0 } });
  }
}

// ------------------------------------------------------------------ PO links (Procurement stays authoritative)
export async function linkPurchaseOrder({ orgId, membership, actorEmail, jobId, purchaseOrderId, unlink = false }) {
  const d = await opsAccess({ orgId, membership, need: "edit_job" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r;
  const { purchaseOrders } = await getOrgCollections();
  const po = await purchaseOrders.findOne({ _id: oid(purchaseOrderId), orgId: oid(orgId) }, { projection: { poNumber: 1, departmentId: 1 } });
  if (!po) return fail("Purchase order not found.", 404);
  const c = await ccol(); await c.updateOne({ _id: r.job._id }, { [unlink ? "$pull" : "$addToSet"]: { poIds: po._id }, $set: { updatedAt: nowIso() } });
  await audit({ orgId, actorEmail, recordType: r.job.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: r.job._id, action: unlink ? "OPS_PO_UNLINKED" : "OPS_PO_LINKED", metadata: { purchaseOrderId: sid(po._id), poNumber: po.poNumber || null } });
  return { ok: true };
}

// ------------------------------------------------------------------ assets
export const assetLabel = (a) => [a.make, a.model, a.identifier].filter(Boolean).join(" · ") || a.type;
export const assetView = (a) => ({ id: sid(a._id), type: a.type, make: a.make, model: a.model, identifier: a.identifier, year: a.year || null, warranty: a.warranty || null, contactId: sid(a.contactId), notes: a.notes || "", label: assetLabel(a), createdAt: a.createdAt });
export async function saveAsset({ orgId, membership, actorEmail, assetId, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "edit_job" }); if (d) return d; await ensureOpsIndexes();
  const type = clean(input.type, 60); if (!type) return fail("Asset type is required (for example Car, Phone, Laptop, Generator).");
  const { crmContacts } = await getOrgCollections();
  if (input.contactId && !await crmContacts.findOne({ _id: oid(input.contactId), orgId: oid(orgId), deletedAt: null }, { projection: { _id: 1 } })) return fail("Customer not found.", 404);
  const w = input.warranty || {};
  const doc = { type, make: clean(input.make, 80), model: clean(input.model, 80), identifier: clean(input.identifier, 80), year: clean(input.year, 10) || null, contactId: oid(input.contactId), notes: clean(input.notes, 1000),
    warranty: w.status || w.ref || w.until ? { status: ["IN_WARRANTY", "OUT_OF_WARRANTY", "UNKNOWN"].includes(w.status) ? w.status : "UNKNOWN", ref: clean(w.ref, 80) || null, until: iso(w.until) } : null, updatedAt: nowIso() };
  const c = await ccol();
  if (assetId) { const u = await c.findOneAndUpdate({ _id: oid(assetId), orgId: oid(orgId), kind: K.asset }, { $set: doc }, { returnDocument: "after" }); if (!u) return fail("Asset not found.", 404); return { asset: assetView(u) }; }
  const full = { orgId: oid(orgId), kind: K.asset, opsDoc: true, ...doc, createdBy: actorEmail, createdAt: doc.updatedAt };
  const r = await c.insertOne(full); full._id = r.insertedId;
  await audit({ orgId, actorEmail, recordType: "SERVICE_ASSET", recordId: r.insertedId, action: "OPS_ASSET_CREATED", metadata: { type } });
  return { asset: assetView(full) };
}
export async function listAssets({ orgId, membership, contactId, q }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d;
  const f = { orgId: oid(orgId), kind: K.asset }; if (contactId) f.contactId = oid(contactId);
  if (q) { const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i"); f.$or = [{ make: rx }, { model: rx }, { identifier: rx }, { type: rx }]; }
  const c = await ccol(); const rows = await c.find(f).sort({ updatedAt: -1 }).limit(100).toArray();
  return { assets: rows.map(assetView) };
}
/** Service history of one asset: every order for it, with repeat-repair and warranty visibility. */
export async function assetHistory({ orgId, membership, assetId }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d;
  const c = await ccol(); const a = await c.findOne({ _id: oid(assetId), orgId: oid(orgId), kind: K.asset }); if (!a) return fail("Asset not found.", 404);
  const jobs = await c.find({ orgId: oid(orgId), kind: K.job, assetId: a._id, ...scopeFilter(membership, "warehouseId") }).sort({ createdAt: -1 }).limit(100).toArray();
  const done = jobs.filter((j) => ["COMPLETED", "INVOICED", "CLOSED"].includes(j.status));
  const repeat = done.length > 1 && (new Date(done[0].createdAt) - new Date(done[1].completion?.at || done[1].updatedAt)) < 30 * 86400000;
  return { asset: assetView(a), jobs: jobs.map((j) => ({ id: sid(j._id), number: j.number, type: j.type, status: j.status, title: j.title, createdAt: j.createdAt })), repeatRepairWithin30Days: repeat };
}

// ------------------------------------------------------------------ RO: intake acknowledgement, diagnosis, estimates, authorisation, invoice
export async function recordIntakeAck({ orgId, membership, actorEmail, jobId, customerName, method }) {
  const d = await opsAccess({ orgId, membership, need: "edit_job" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; if (r.job.type !== "RO") return fail("Only repair orders have an intake.");
  const name = clean(customerName, 120); if (name.length < 2) return fail("Type the name of the person who handed the item over.");
  const m = ["signed_paper", "in_person", "e_signature"].includes(method) ? method : "in_person";
  const ack = { customerName: name, method: m, recordedBy: actorEmail, at: nowIso() };
  const c = await ccol(); await c.updateOne({ _id: r.job._id }, { $set: { "intake.acknowledgement": ack, updatedAt: ack.at } });
  await audit({ orgId, actorEmail, recordType: "REPAIR_ORDER", recordId: r.job._id, action: "RO_INTAKE_ACKNOWLEDGED", metadata: { method: m } });
  return { acknowledgement: ack };
}
export async function recordDiagnosis({ orgId, membership, actorEmail, jobId, input = {} }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job; if (j.type !== "RO") return fail("Only repair orders have a diagnosis.");
  if (isTech(membership) && !(j.assigneeEmails || []).includes(actorEmail)) return fail("This job isn't assigned to you.", 403);
  if (!["RECEIVED", "INSPECTION", "DIAGNOSIS", "ESTIMATE_PREPARED", "IN_REPAIR"].includes(j.status)) return fail("The diagnosis can't be changed at this stage.", 409);
  const diag = { findings: clean(input.findings, 4000), faultCodes: (Array.isArray(input.faultCodes) ? input.faultCodes : String(input.faultCodes || "").split(",")).map((x) => clean(x, 30)).filter(Boolean).slice(0, 30), recommended: clean(input.recommended, 4000), by: actorEmail, at: nowIso() };
  if (!diag.findings) return fail("Write the findings.");
  const c = await ccol(); await c.updateOne({ _id: j._id }, { $set: { diagnosis: diag, updatedAt: diag.at, lastActivityAt: diag.at, ...(["RECEIVED", "INSPECTION"].includes(j.status) ? { status: "DIAGNOSIS" } : {}) }, ...(["RECEIVED", "INSPECTION"].includes(j.status) ? { $push: { history: { from: j.status, to: "DIAGNOSIS", action: "diagnose", by: actorEmail, at: diag.at } } } : {}) });
  await audit({ orgId, actorEmail, recordType: "REPAIR_ORDER", recordId: j._id, action: "RO_DIAGNOSIS_RECORDED" });
  return { diagnosis: diag };
}

export const estimateView = (e) => ({ id: sid(e._id), version: e.version, status: e.status, lines: e.lines, currency: e.currency, taxPercent: e.taxPercent, subtotal: e.subtotal, tax: e.tax, total: e.total, changeOrder: !!e.changeOrder, note: e.note || "", createdBy: e.createdBy, createdAt: e.createdAt, decision: e.decision || null });
/** A new estimate version. After an approved version exists this is a CHANGE ORDER: work stops being authorised for
 *  the extra scope until the customer approves the new version (SOW 7.3). */
export async function createEstimate({ orgId, membership, actorEmail, jobId, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "estimate" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job; if (j.type !== "RO") return fail("Estimates belong to repair orders.");
  if (!["DIAGNOSIS", "ESTIMATE_PREPARED", "AWAITING_APPROVAL", "APPROVED", "AWAITING_PARTS", "READY", "SCHEDULED", "IN_REPAIR"].includes(j.status)) return fail("Record the diagnosis before preparing an estimate.", 409);
  const cur = String(input.currency || "PKR").toUpperCase(); if (!isSupportedCurrency(cur)) return fail(`Unsupported currency "${cur}".`);
  const raw = Array.isArray(input.lines) ? input.lines.slice(0, 200) : [];
  const lines = raw.map((l) => ({ kind: ["part", "labour", "other"].includes(l.kind) ? l.kind : "other", description: clean(l.description, 200), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), productId: l.kind === "part" ? sid(l.productId) : null }));
  const { lineItems, error } = validateInvoiceLines(lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })));
  if (error) return fail(error);
  const taxPercent = input.taxPercent === undefined || input.taxPercent === "" ? 0 : Number(input.taxPercent);
  if (!(taxPercent >= 0 && taxPercent <= 100)) return fail("Tax percent must be 0–100.");
  let totals; try { totals = computeInvoiceTotals({ lineItems, currency: cur, terms: { taxPercent } }); } catch (e) { return fail(`Cannot total the estimate: ${e.message}`); }
  const c = await ccol(); const version = (j.estimateVersion || 0) + 1; const at = nowIso(); const changeOrder = !!j.approvedEstimateVersion;
  await c.updateMany({ orgId: j.orgId, kind: K.estimate, jobId: j._id, status: { $in: ["DRAFT", "SENT", "REVISION_REQUESTED"] } }, { $set: { status: "SUPERSEDED", updatedAt: at } });
  const doc = { orgId: j.orgId, kind: K.estimate, opsDoc: true, opsKey: `est:${sid(j._id)}:${version}`, jobId: j._id, version, status: "SENT", changeOrder, lines, currency: cur, taxPercent, subtotal: totals.subtotal, tax: totals.taxAmount ?? totals.tax ?? Math.round((totals.total - totals.subtotal) * 100) / 100, total: totals.total, note: clean(input.note, 1000), createdBy: actorEmail, createdAt: at, at };
  try { const ins = await c.insertOne(doc); doc._id = ins.insertedId; } catch (e) { if (e?.code === 11000) return fail("Someone else created an estimate at the same time. Reload.", 409); throw e; }
  const next = changeOrder ? "AWAITING_APPROVAL" : (j.status === "DIAGNOSIS" ? "AWAITING_APPROVAL" : j.status);
  await c.updateOne({ _id: j._id }, { $set: { estimateVersion: version, pendingChangeOrder: changeOrder, status: next, updatedAt: at, lastActivityAt: at, ...(changeOrder ? { preChangeStatus: j.status } : {}) }, $push: { history: { from: j.status, to: next, action: changeOrder ? "change_order" : "estimate", by: actorEmail, at, version } } });
  await audit({ orgId, actorEmail, recordType: "REPAIR_ORDER", recordId: j._id, action: changeOrder ? "RO_CHANGE_ORDER_CREATED" : "RO_ESTIMATE_CREATED", metadata: { version, total: doc.total } });
  return { estimate: estimateView(doc) };
}
/** decision: approve | reject | revise. The customer's decision is recorded by staff with the method and the customer's
 *  name; an estimate is never "approved" just because it was created or sent (SOW 7.3). */
export async function decideEstimate({ orgId, membership, actorEmail, jobId, estimateId, decision, customerName, method, note }) {
  const d = await opsAccess({ orgId, membership, need: "estimate" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  const c = await ccol(); const e = await c.findOne({ _id: oid(estimateId), orgId: j.orgId, kind: K.estimate, jobId: j._id });
  if (!e) return fail("Estimate not found.", 404);
  if (e.version !== j.estimateVersion || e.status !== "SENT") return fail("Only the latest sent estimate can be decided.", 409);
  if (!["approve", "reject", "revise"].includes(decision)) return fail("decision must be approve, reject or revise.");
  const who = clean(customerName, 120); if (who.length < 2) return fail("Record the customer's name.");
  const how = ["in_person", "phone", "email", "whatsapp", "signed", "e_signature"].includes(method) ? method : null; if (!how) return fail("Record how the customer gave their decision.");
  const at = nowIso(); const status = { approve: "APPROVED", reject: "REJECTED", revise: "REVISION_REQUESTED" }[decision];
  const u = await c.findOneAndUpdate({ _id: e._id, status: "SENT" }, { $set: { status, decision: { customerName: who, method: how, note: clean(note, 1000) || null, recordedBy: actorEmail, at }, updatedAt: at } }, { returnDocument: "after" });
  if (!u) return fail("This estimate was decided at the same time. Reload.", 409);
  let next = j.status; const set = { updatedAt: at, lastActivityAt: at };
  if (decision === "approve") { set.approvedEstimateVersion = e.version; set.pendingChangeOrder = false; next = e.changeOrder ? (j.preChangeStatus || "APPROVED") : "APPROVED"; }
  else if (decision === "revise") next = "ESTIMATE_PREPARED";
  else if (decision === "reject") { set.pendingChangeOrder = false; next = e.changeOrder ? (j.preChangeStatus || "APPROVED") : "ESTIMATE_PREPARED"; }
  set.status = next;
  await c.updateOne({ _id: j._id }, { $set: set, $push: { history: { from: j.status, to: next, action: `estimate_${decision}`, by: actorEmail, at, version: e.version } } });
  await audit({ orgId, actorEmail, recordType: "REPAIR_ORDER", recordId: j._id, action: `RO_ESTIMATE_${status}`, metadata: { version: e.version, method: how } });
  return { estimate: estimateView(u), status: next };
}
/** RO invoice: one invoice, through the existing engine, from the latest APPROVED estimate. Never twice. */
export async function invoiceRepair({ orgId, membership, actorEmail, jobId, departmentId }) {
  const d = await opsAccess({ orgId, membership, need: "edit_job" }); if (d) return d;
  if (!canAccessFinance(membership) && opsRoleOf(membership) !== "manager") return fail("Creating invoices needs finance access.", 403);
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  if (j.type !== "RO") return fail("Only repair orders are invoiced here.");
  if (j.invoiceId) return fail("This repair order already has an invoice.", 409, "ALREADY_INVOICED");
  if (j.status !== "COMPLETED") return fail("Complete the repair (customer collection or delivery) before invoicing.", 409);
  const dept = oid(departmentId) || j.departmentId; if (!dept) return fail("Choose the department the invoice belongs to.");
  if (!canAccessDepartment(membership, sid(dept))) return fail("You don't have access to that department.", 403);
  const c = await ccol(); const est = await c.findOne({ orgId: j.orgId, kind: K.estimate, jobId: j._id, version: j.approvedEstimateVersion, status: "APPROVED" });
  if (!est) return fail("There is no customer-approved estimate to invoice.", 409);
  const { lineItems, error } = validateInvoiceLines(est.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })));
  if (error) return fail(error);
  let totals; try { totals = computeInvoiceTotals({ lineItems, currency: est.currency, terms: { taxPercent: est.taxPercent || 0 } }); } catch (e) { return fail(`Cannot total the invoice: ${e.message}`); }
  const locked = await c.findOneAndUpdate({ _id: j._id, status: "COMPLETED", invoiceId: null, invoicing: { $ne: true } }, { $set: { invoicing: true } });
  if (!locked) return fail("This repair order is being invoiced already.", 409);
  try {
    const { invoices, crmContacts } = await getOrgCollections(); const now = nowIso();
    const contact = await crmContacts.findOne({ _id: j.contactId }); const days = Number.parseInt(String(contact?.paymentTerms || "").replace(/\D/g, ""), 10);
    const due = new Date(Date.now() + (Number.isFinite(days) && days > 0 ? days : 30) * 86400000).toISOString().slice(0, 10);
    const inv = await invoices.insertOne({ orgId: j.orgId, departmentId: dept, contactId: j.contactId, invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}`, issueDate: now, dueDate: due, lineItems, subtotal: totals.subtotal, total: totals.total, currency: est.currency, status: "DRAFT", taxPercent: est.taxPercent || 0, notes: `From repair order ${j.number} (estimate v${est.version})`, reference: j.number, relatedRepairOrderId: j._id, createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null });
    await c.updateOne({ _id: j._id }, { $set: { invoiceId: inv.insertedId, status: "INVOICED", departmentId: dept, updatedAt: now }, $unset: { invoicing: "" }, $push: { history: { from: "COMPLETED", to: "INVOICED", action: "invoice", by: actorEmail, at: now } } });
    await audit({ orgId, actorEmail, recordType: "REPAIR_ORDER", recordId: j._id, action: "RO_INVOICED", previousState: "COMPLETED", newState: "INVOICED", metadata: { invoiceId: sid(inv.insertedId), total: totals.total } });
    return { invoiceId: sid(inv.insertedId), total: totals.total, currency: est.currency };
  } catch (e) { await c.updateOne({ _id: j._id }, { $unset: { invoicing: "" } }); throw e; }
}
/** RO completion report + customer sign-off at collection/delivery. */
export async function recordCompletion({ orgId, membership, actorEmail, jobId, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "edit_job" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  if (!["READY_FOR_COLLECTION", "COMPLETED", "AWAITING_INSPECTION"].includes(j.status) && !(j.type === "WO" && j.status === "COMPLETED")) return fail("The completion report is written once the work has passed checks.", 409);
  const comp = { summary: clean(input.summary, 4000), warrantyNotes: clean(input.warrantyNotes, 1000), customerSignoff: input.customerName ? { customerName: clean(input.customerName, 120), method: ["in_person", "signed", "e_signature"].includes(input.method) ? input.method : "in_person", at: nowIso() } : null, collection: ["collected", "delivered"].includes(input.collection) ? input.collection : null, by: actorEmail, at: nowIso() };
  if (!comp.summary) return fail("Write a short completion summary.");
  const c = await ccol(); await c.updateOne({ _id: j._id }, { $set: { completion: comp, updatedAt: comp.at } });
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: `${j.type}_COMPLETION_RECORDED`, metadata: { signoff: !!comp.customerSignoff } });
  return { completion: comp };
}

export { TERMINAL, isTech, viewFor };
