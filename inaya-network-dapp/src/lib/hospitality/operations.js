// src/lib/hospitality/operations.js
//
// Daily operations (SOW 13): shift roster with swaps, opening/closing checklists, service incidents.
// Staff are existing HR employees; approved leave comes from HR. No payroll, timekeeping or labour-law
// calculations are done here.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { zonedToUtc, zonedDateKey, addDaysKey, minutesOf, overlaps } from "../engagement/time.js";
import { hcol, KINDS, CAN, fail, clean, nowIso, oid, sid, intIn, normEmail, isEmail, logH, emitH, notifyRoles, requireLocation, allowedLocations, nextNumber, canManageHospitality } from "./store.js";

// ================= shifts =================
export const SHIFT_ROLES = ["manager", "host", "server", "bartender", "chef", "kitchen", "dishwasher", "cashier", "delivery", "cleaner", "other"];

/** Pure: do two shifts for the same person overlap? */
export const shiftsOverlap = (a, b) => normEmail(a.email) === normEmail(b.email) && overlaps(a.start, a.end, b.start, b.end);

const shiftView = (s) => ({ id: sid(s._id), locationId: sid(s.locationId), email: s.email, name: s.name || null, role: s.role, date: s.date, start: s.start, end: s.end, startTime: s.startTime, endTime: s.endTime, note: s.note || null, status: s.status, swap: s.swap || null });

async function staffDirectory(orgId) {
  const { employees, orgMembers } = await getOrgCollections();
  const org = toObjectId(orgId);
  const [emps, members] = await Promise.all([
    employees.find({ orgId: org, deletedAt: null }).project({ memberEmail: 1, contactEmail: 1, fullName: 1, jobTitle: 1, employmentStatus: 1 }).limit(1000).toArray(),
    orgMembers.find({ orgId: org, status: "active" }).project({ email: 1, name: 1 }).limit(1000).toArray(),
  ]);
  const map = new Map();
  for (const m of members) map.set(normEmail(m.email), { email: normEmail(m.email), name: m.name || null, jobTitle: null, employeeId: null });
  for (const e of emps) { const k = normEmail(e.memberEmail || e.contactEmail); if (!k) continue; map.set(k, { email: k, name: e.fullName, jobTitle: e.jobTitle || null, employeeId: e._id }); }
  return map;
}

/** Approved HR leave overlapping a date range, by employee email. Read-only visibility (SOW 13.1). */
async function approvedLeave(orgId, directory, fromKey, toKey) {
  const { leaveRequests } = await getOrgCollections();
  const ids = [...directory.values()].map((d) => d.employeeId).filter(Boolean);
  if (!ids.length) return [];
  const rows = await leaveRequests.find({ orgId: toObjectId(orgId), employeeId: { $in: ids }, status: "APPROVED" }).project({ employeeId: 1, startDate: 1, endDate: 1, leaveType: 1 }).limit(2000).toArray();
  const byEmp = new Map([...directory.values()].filter((d) => d.employeeId).map((d) => [String(d.employeeId), d.email]));
  return rows.map((r) => ({ email: byEmp.get(String(r.employeeId)), from: String(r.startDate).slice(0, 10), to: String(r.endDate).slice(0, 10), leaveType: r.leaveType })).filter((r) => r.email && r.from <= toKey && r.to >= fromKey);
}

export async function getRoster({ orgId, membership, actorEmail, locationId, weekStart }) {
  if (!CAN.rosterRead(membership)) return fail("You don't have access to the roster.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(weekStart || "") ? weekStart : zonedDateKey(new Date(), got.location.timeZone), to = addDaysKey(from, 6);
  const c = await hcol();
  const org = toObjectId(orgId), edit = CAN.rosterEdit(membership), me = normEmail(actorEmail);
  const filter = { orgId: org, kind: KINDS.shift, locationId: got.location._id, date: { $gte: from, $lte: to } };
  // Staff see the published roster; drafts are the manager's working copy.
  if (!edit) filter.status = "PUBLISHED";
  const [shifts, unavailable, directory] = await Promise.all([c.find(filter).sort({ start: 1 }).limit(2000).toArray(), c.find({ orgId: org, kind: KINDS.unavailable, date: { $gte: from, $lte: to }, ...(edit ? {} : { email: me }) }).limit(2000).toArray(), staffDirectory(orgId)]);
  const leave = edit ? await approvedLeave(orgId, directory, from, to) : [];
  return {
    weekStart: from, weekEnd: to, timeZone: got.location.timeZone, canEdit: edit, roles: SHIFT_ROLES,
    shifts: shifts.map(shiftView), staff: edit ? [...directory.values()].map((d) => ({ email: d.email, name: d.name, jobTitle: d.jobTitle })) : [],
    unavailable: unavailable.map((u) => ({ id: sid(u._id), email: u.email, date: u.date, note: u.note || null })), leave,
    draftCount: shifts.filter((s) => s.status === "DRAFT").length,
  };
}

async function shiftWarnings(orgId, candidate, excludeId = null) {
  const c = await hcol();
  const org = toObjectId(orgId);
  const warnings = [];
  const same = await c.find({ orgId: org, kind: KINDS.shift, email: candidate.email, date: { $gte: addDaysKey(candidate.date, -1), $lte: addDaysKey(candidate.date, 1) }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).toArray();
  if (same.some((s) => shiftsOverlap(s, candidate))) warnings.push({ type: "overlap", message: "This person already has a shift that overlaps." });
  if (await c.findOne({ orgId: org, kind: KINDS.unavailable, email: candidate.email, date: candidate.date })) warnings.push({ type: "unavailable", message: "This person marked themselves unavailable that day." });
  const directory = await staffDirectory(orgId);
  if ((await approvedLeave(orgId, new Map([[candidate.email, directory.get(candidate.email) || { email: candidate.email }]]), candidate.date, candidate.date)).length) warnings.push({ type: "leave", message: "This person has approved leave that day." });
  return warnings;
}

export async function saveShift({ orgId, membership, actorEmail, locationId, shiftId, email, role, date, startTime, endTime, note, allowOverlap }) {
  if (!CAN.rosterEdit(membership)) return fail("Only a manager can change the roster.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const e = normEmail(email);
  const directory = await staffDirectory(orgId);
  if (!isEmail(e) || !directory.has(e)) return fail("Choose a member of staff from your team.");
  if (!SHIFT_ROLES.includes(role)) return fail(`Role must be one of: ${SHIFT_ROLES.join(", ")}.`);
  const a = minutesOf(startTime), b = minutesOf(endTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || a === null || b === null || a === b) return fail("Give a date, a start time and a different end time.");
  const start = zonedToUtc(date, startTime, got.location.timeZone);
  // An end time earlier than the start means the shift finishes after midnight.
  const end = zonedToUtc(b > a ? date : addDaysKey(date, 1), endTime, got.location.timeZone);
  if (end - start > 16 * 3600000) return fail("A shift can be at most 16 hours.");
  const c = await hcol();
  const existing = shiftId ? await c.findOne({ _id: oid(shiftId), orgId: toObjectId(orgId), kind: KINDS.shift, locationId: got.location._id }) : null;
  if (shiftId && !existing) return fail("Shift not found.", 404);
  const candidate = { email: e, date, start, end };
  const warnings = await shiftWarnings(orgId, candidate, existing?._id);
  if (warnings.some((w) => w.type === "overlap") && allowOverlap !== true) return { ...fail("This person already has a shift that overlaps. Save again to keep both.", 409), warnings };
  const set = { email: e, name: directory.get(e)?.name || null, role, date, startTime, endTime, start, end, note: clean(note, 300) || null, updatedAt: nowIso(), updatedByEmail: actorEmail };
  let doc;
  if (existing) {
    // Editing a published shift is a change staff need to hear about.
    await c.updateOne({ _id: existing._id }, { $set: { ...set, ...(existing.status === "PUBLISHED" ? { changedAfterPublish: true } : {}) } });
    doc = { ...existing, ...set };
    if (existing.status === "PUBLISHED") await notifyShift(orgId, got.location, doc, "Your shift has changed");
  } else { doc = { orgId: toObjectId(orgId), kind: KINDS.shift, locationId: got.location._id, status: "DRAFT", ...set, createdByEmail: actorEmail, createdAt: nowIso() }; doc._id = (await c.insertOne(doc)).insertedId; }
  await logH({ orgId, recordType: "SHIFT", recordId: doc._id, actorEmail, action: existing ? "SHIFT_UPDATED" : "SHIFT_CREATED", metadata: { email: e, date, startTime, endTime, role } });
  if (existing?.status === "PUBLISHED") emitH(orgId, "shift.changed", `${doc._id}:${Date.now()}`, { shift: { id: String(doc._id), email: e, date, startTime, endTime, role, locationId: String(got.location._id) } });
  return { shift: shiftView(doc), warnings };
}

async function notifyShift(orgId, location, s, title) {
  try {
    const { createNotification } = await import("../notifications.js");
    await createNotification({ scope: "org", orgId, targetEmail: s.email, category: "business", type: "shift", title, body: `${s.date}, ${s.startTime} to ${s.endTime} at ${location.name} (${s.role}).`, sourceModule: "hospitality", sourceId: String(s._id), actionUrl: "/business?view=hospitality", dedupeKey: `hospitality:shift:${s._id}:${s.date}:${s.startTime}:${s.endTime}:${title}` });
  } catch (e) { console.error("hospitality shift notify failed:", e.message); }
}

export async function deleteShift({ orgId, membership, actorEmail, shiftId }) {
  if (!CAN.rosterEdit(membership)) return fail("Only a manager can change the roster.", 403);
  const c = await hcol();
  const s = await c.findOne({ _id: oid(shiftId), orgId: toObjectId(orgId), kind: KINDS.shift });
  if (!s) return fail("Shift not found.", 404);
  const got = await requireLocation(orgId, membership, s.locationId);
  if (got.error) return fail("Shift not found.", 404);
  await c.deleteOne({ _id: s._id });
  if (s.status === "PUBLISHED") await notifyShift(orgId, got.location, s, "Your shift has been removed");
  await logH({ orgId, recordType: "SHIFT", recordId: s._id, actorEmail, action: "SHIFT_REMOVED", metadata: { email: s.email, date: s.date } });
  return { ok: true };
}

export async function publishRoster({ orgId, membership, actorEmail, locationId, weekStart }) {
  if (!CAN.rosterEdit(membership)) return fail("Only a manager can publish the roster.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart || "")) return fail("Choose the week to publish.");
  const c = await hcol();
  const filter = { orgId: toObjectId(orgId), kind: KINDS.shift, locationId: got.location._id, date: { $gte: weekStart, $lte: addDaysKey(weekStart, 6) }, status: "DRAFT" };
  const drafts = await c.find(filter).toArray();
  if (!drafts.length) return fail("There are no unpublished shifts in that week.", 409);
  await c.updateMany(filter, { $set: { status: "PUBLISHED", publishedAt: nowIso(), publishedByEmail: actorEmail } });
  for (const s of drafts) await notifyShift(orgId, got.location, s, "You have a new shift");
  await logH({ orgId, recordType: "ROSTER", recordId: null, actorEmail, action: "ROSTER_PUBLISHED", metadata: { weekStart, shifts: drafts.length, locationId: String(got.location._id) } });
  emitH(orgId, "shift.published", `${got.location._id}:${weekStart}:${Date.now()}`, { weekStart, shifts: drafts.length, locationId: String(got.location._id) });
  return { published: drafts.length };
}

export async function setUnavailable({ orgId, membership, actorEmail, date, note, remove }) {
  if (!CAN.rosterRead(membership)) return fail("You don't have access to the roster.", 403);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return fail("Choose a date.");
  const c = await hcol();
  const key = { orgId: toObjectId(orgId), kind: KINDS.unavailable, email: normEmail(actorEmail), date };
  if (remove) await c.deleteOne(key); else await c.updateOne(key, { $set: { note: clean(note, 200) || null, updatedAt: nowIso() }, $setOnInsert: { ...key, createdAt: nowIso() } }, { upsert: true });
  return { ok: true };
}

/** A member of staff asks to hand their own published shift to a colleague; a manager decides (SOW 13.1). */
export async function requestSwap({ orgId, membership, actorEmail, shiftId, toEmail, note }) {
  if (!CAN.rosterRead(membership)) return fail("You don't have access to the roster.", 403);
  const c = await hcol();
  const s = await c.findOne({ _id: oid(shiftId), orgId: toObjectId(orgId), kind: KINDS.shift, status: "PUBLISHED" });
  if (!s || normEmail(s.email) !== normEmail(actorEmail)) return fail("You can only ask to swap your own published shift.", 404);
  if (new Date(s.start) <= new Date()) return fail("This shift has already started.", 409);
  const to = normEmail(toEmail);
  if (!(await staffDirectory(orgId)).has(to) || to === normEmail(actorEmail)) return fail("Choose a colleague to take the shift.");
  await c.updateOne({ _id: s._id }, { $set: { swap: { status: "PENDING", requestedByEmail: normEmail(actorEmail), toEmail: to, note: clean(note, 200) || null, requestedAt: nowIso() }, updatedAt: nowIso() } });
  await logH({ orgId, recordType: "SHIFT", recordId: s._id, actorEmail, action: "SHIFT_SWAP_REQUESTED", metadata: { toEmail: to, date: s.date } });
  await notifyRoles({ orgId, locationId: s.locationId, roles: [], type: "shift_swap", sourceId: `${s._id}:${to}`, title: "A shift swap needs a decision", body: `${s.date}, ${s.startTime} to ${s.endTime}.` });
  return { ok: true };
}

export async function decideSwap({ orgId, membership, actorEmail, shiftId, approve, allowOverlap }) {
  if (!CAN.rosterEdit(membership)) return fail("Only a manager can decide a shift swap.", 403);
  const c = await hcol();
  const s = await c.findOne({ _id: oid(shiftId), orgId: toObjectId(orgId), kind: KINDS.shift });
  if (!s || s.swap?.status !== "PENDING") return fail("No pending swap for this shift.", 404);
  const got = await requireLocation(orgId, membership, s.locationId);
  if (got.error) return fail("Shift not found.", 404);
  if (!approve) { await c.updateOne({ _id: s._id }, { $set: { "swap.status": "REJECTED", "swap.decidedByEmail": actorEmail, "swap.decidedAt": nowIso() } }); await notifyShift(orgId, got.location, s, "Your shift swap was not approved"); return { ok: true, status: "REJECTED" }; }
  const warnings = await shiftWarnings(orgId, { email: s.swap.toEmail, date: s.date, start: s.start, end: s.end }, s._id);
  if (warnings.some((w) => w.type === "overlap") && allowOverlap !== true) return { ...fail("The colleague already has a shift that overlaps.", 409), warnings };
  const directory = await staffDirectory(orgId);
  const next = { ...s, email: s.swap.toEmail, name: directory.get(s.swap.toEmail)?.name || null };
  await c.updateOne({ _id: s._id }, { $set: { email: next.email, name: next.name, "swap.status": "APPROVED", "swap.decidedByEmail": actorEmail, "swap.decidedAt": nowIso(), updatedAt: nowIso() } });
  await notifyShift(orgId, got.location, s, "Your shift swap was approved: this shift is no longer yours");
  await notifyShift(orgId, got.location, next, "You have a new shift (swap approved)");
  await logH({ orgId, recordType: "SHIFT", recordId: s._id, actorEmail, action: "SHIFT_SWAP_APPROVED", metadata: { from: s.email, to: next.email, date: s.date } });
  emitH(orgId, "shift.changed", `${s._id}:swap:${Date.now()}`, { shift: { id: String(s._id), email: next.email, date: s.date, startTime: s.startTime, endTime: s.endTime, role: s.role, locationId: String(s.locationId) } });
  return { ok: true, status: "APPROVED", warnings };
}

// ================= checklists =================
export const CHECKLIST_TYPES = ["opening", "closing", "cleaning", "custom"];
export const DEFAULT_TEMPLATES = {
  opening: ["Unlock and switch on lights, music and air conditioning", "Check dining area: tables set, floors clean, menus in place", "Check fridges and freezers are at temperature", "Check equipment: ovens, fryers, coffee machine", "Check today's reservations and private events", "Count the cash float and record it", "Check stock for today's menu and note shortages"],
  closing: ["Clean and sanitise kitchen surfaces and equipment", "Label, date and store food; discard what can't be kept", "Record today's wastage", "Empty bins and clean the dining area", "Record the cash-close figure (record only)", "Switch off equipment, gas and lights", "Lock doors, set the alarm"],
};

/** Pure: validates template items [{ label, dueTime, requiresEvidence }]. */
export function normalizeChecklistItems(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) return { error: "Add at least one checklist item." };
  if (list.length > 60) return { error: "A checklist may have at most 60 items." };
  const items = [];
  for (const i of list) {
    const label = clean(typeof i === "string" ? i : i?.label, 200);
    if (!label) return { error: "Every checklist item needs a description." };
    const dueTime = typeof i === "object" && i?.dueTime ? i.dueTime : null;
    if (dueTime && minutesOf(dueTime) === null) return { error: "Due times must look like 10:30." };
    items.push({ label, dueTime, requiresEvidence: typeof i === "object" && i?.requiresEvidence === true });
  }
  return { items };
}

const tplView = (t) => ({ id: sid(t._id), locationId: sid(t.locationId), name: t.name, type: t.type, items: t.items, active: t.active !== false });
const runView = (r) => ({ id: sid(r._id), templateId: sid(r.templateId), locationId: sid(r.locationId), name: r.name, type: r.type, date: r.date, status: r.status, items: r.items, completedAt: r.completedAt || null, startedByEmail: r.startedByEmail });

export async function listChecklists({ orgId, membership, locationId, date }) {
  if (!CAN.checklists(membership)) return fail("You don't have access to checklists.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : zonedDateKey(new Date(), got.location.timeZone);
  const c = await hcol();
  const org = toObjectId(orgId);
  const [templates, runs] = await Promise.all([c.find({ orgId: org, kind: KINDS.checklistTpl, locationId: got.location._id, deletedAt: null }).sort({ type: 1, name: 1 }).limit(100).toArray(), c.find({ orgId: org, kind: KINDS.checklistRun, locationId: got.location._id, date: day }).limit(100).toArray()]);
  return { date: day, templates: templates.map(tplView), runs: runs.map(runView), types: CHECKLIST_TYPES, suggestions: DEFAULT_TEMPLATES, canManage: CAN.manage(membership) };
}

export async function saveChecklistTemplate({ orgId, membership, actorEmail, locationId, templateId, name, type, items, active, remove }) {
  if (!CAN.manage(membership)) return fail("Only a manager can change checklist templates.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const c = await hcol();
  const org = toObjectId(orgId);
  if (remove && templateId) { const r = await c.updateOne({ _id: oid(templateId), orgId: org, kind: KINDS.checklistTpl, locationId: got.location._id }, { $set: { deletedAt: nowIso() } }); return r.matchedCount ? { ok: true } : fail("Template not found.", 404); }
  const n = clean(name, 80);
  if (!n) return fail("Give the checklist a name.");
  if (!CHECKLIST_TYPES.includes(type)) return fail(`Type must be one of: ${CHECKLIST_TYPES.join(", ")}.`);
  const it = normalizeChecklistItems(items);
  if (it.error) return fail(it.error);
  const set = { name: n, type, items: it.items, active: active !== false, updatedAt: nowIso(), updatedByEmail: actorEmail };
  if (templateId) { const r = await c.updateOne({ _id: oid(templateId), orgId: org, kind: KINDS.checklistTpl, locationId: got.location._id, deletedAt: null }, { $set: set }); if (!r.matchedCount) return fail("Template not found.", 404); return { template: tplView({ _id: oid(templateId), locationId: got.location._id, ...set }) }; }
  const doc = { orgId: org, kind: KINDS.checklistTpl, locationId: got.location._id, ...set, createdAt: nowIso(), deletedAt: null };
  doc._id = (await c.insertOne(doc)).insertedId;
  await logH({ orgId, recordType: "CHECKLIST", recordId: doc._id, actorEmail, action: "CHECKLIST_TEMPLATE_CREATED", metadata: { name: n, type, items: it.items.length } });
  return { template: tplView(doc) };
}

/** Starts today's run of a template. Idempotent: one run per template per day (unique key). */
export async function startChecklistRun({ orgId, membership, actorEmail, templateId, date }) {
  if (!CAN.checklists(membership)) return fail("You don't have access to checklists.", 403);
  const c = await hcol();
  const org = toObjectId(orgId);
  const t = await c.findOne({ _id: oid(templateId), orgId: org, kind: KINDS.checklistTpl, deletedAt: null });
  if (!t) return fail("Checklist not found.", 404);
  const got = await requireLocation(orgId, membership, t.locationId);
  if (got.error) return fail("Checklist not found.", 404);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : zonedDateKey(new Date(), got.location.timeZone);
  const key = `run:${t._id}:${day}`;
  const doc = { orgId: org, kind: KINDS.checklistRun, runKey: key, templateId: t._id, locationId: t.locationId, name: t.name, type: t.type, date: day, status: "IN_PROGRESS", items: t.items.map((i, n) => ({ n, label: i.label, requiresEvidence: !!i.requiresEvidence, dueAt: i.dueTime ? zonedToUtc(day, i.dueTime, got.location.timeZone).toISOString() : null, done: false, doneByEmail: null, doneAt: null, note: null, documentId: null, ownerEmail: null })), startedByEmail: actorEmail, createdAt: nowIso(), updatedAt: nowIso() };
  try { doc._id = (await c.insertOne(doc)).insertedId; }
  catch (e) { if (e?.code !== 11000) throw e; return { run: runView(await c.findOne({ orgId: org, kind: KINDS.checklistRun, runKey: key })), existing: true }; }
  return { run: runView(doc) };
}

export async function updateChecklistItem({ orgId, membership, actorEmail, runId, n, done, note, documentId, ownerEmail }) {
  if (!CAN.checklists(membership)) return fail("You don't have access to checklists.", 403);
  const c = await hcol();
  const run = await c.findOne({ _id: oid(runId), orgId: toObjectId(orgId), kind: KINDS.checklistRun });
  if (!run) return fail("Checklist not found.", 404);
  const got = await requireLocation(orgId, membership, run.locationId);
  if (got.error) return fail("Checklist not found.", 404);
  const item = run.items.find((i) => i.n === Number(n));
  if (!item) return fail("Checklist item not found.", 404);
  if (run.status === "COMPLETED" && !canManageHospitality(membership)) return fail("This checklist is completed. A manager can reopen an item.", 409);
  const doc = documentId !== undefined ? oid(documentId) : item.documentId;
  if (done === true && item.requiresEvidence && !doc) return fail("This item needs a photo or document attached before it can be ticked.", 409);
  const next = { ...item, ...(done !== undefined ? { done: done === true, doneByEmail: done === true ? actorEmail : null, doneAt: done === true ? nowIso() : null } : {}), ...(note !== undefined ? { note: clean(note, 300) || null } : {}), documentId: doc || null, ...(ownerEmail !== undefined && canManageHospitality(membership) ? { ownerEmail: normEmail(ownerEmail) || null } : {}) };
  const items = run.items.map((i) => (i.n === item.n ? next : i));
  const all = items.every((i) => i.done);
  await c.updateOne({ _id: run._id }, { $set: { items, status: all ? "COMPLETED" : "IN_PROGRESS", completedAt: all ? nowIso() : null, updatedAt: nowIso() } });
  if (all && run.status !== "COMPLETED") { await logH({ orgId, recordType: "CHECKLIST", recordId: run._id, actorEmail, action: "CHECKLIST_COMPLETED", metadata: { name: run.name, date: run.date } }); emitH(orgId, "checklist.completed", run._id, { checklist: { id: String(run._id), name: run.name, type: run.type, date: run.date, locationId: String(run.locationId) } }); }
  return { run: runView({ ...run, items, status: all ? "COMPLETED" : "IN_PROGRESS", completedAt: all ? nowIso() : null }) };
}

/** Pure: items past their due time and still open. */
export const overdueItems = (run, now = new Date()) => (run.items || []).filter((i) => !i.done && i.dueAt && new Date(i.dueAt) < now);

/** Cron: tell managers once about each checklist that has overdue items (SOW 16.1). */
export async function processOverdueChecklists({ now = new Date() } = {}) {
  const c = await hcol();
  const since = new Date(now.getTime() - 36 * 3600000).toISOString().slice(0, 10);
  const runs = await c.find({ kind: KINDS.checklistRun, status: "IN_PROGRESS", date: { $gte: since }, overdueNotifiedAt: null }).limit(200).toArray();
  let notified = 0;
  for (const run of runs) {
    const late = overdueItems(run, now);
    if (!late.length) continue;
    const claim = await c.updateOne({ _id: run._id, overdueNotifiedAt: null }, { $set: { overdueNotifiedAt: nowIso() } });
    if (!claim.modifiedCount) continue;
    await notifyRoles({ orgId: String(run.orgId), locationId: run.locationId, roles: [], type: "checklist_overdue", sourceId: run._id, title: "A checklist is overdue", body: `${run.name} (${run.date}): ${late.length} item${late.length === 1 ? "" : "s"} past due.`, severity: "warning" });
    emitH(String(run.orgId), "checklist.overdue", run._id, { checklist: { id: String(run._id), name: run.name, type: run.type, date: run.date, overdue: late.length, locationId: String(run.locationId) } });
    notified++;
  }
  return { checked: runs.length, notified };
}

// ================= incidents and service recovery =================
export const INCIDENT_CATEGORIES = ["guest_complaint", "reservation_issue", "delayed_service", "equipment", "stock_shortage", "supplier_delivery", "safety_or_facility"];
export const INCIDENT_SEVERITIES = ["low", "medium", "high"];
export const INCIDENT_STATES = ["OPEN", "IN_PROGRESS", "ESCALATED", "RESOLVED"];
export const INCIDENT_TRANSITIONS = { OPEN: ["IN_PROGRESS", "ESCALATED", "RESOLVED"], IN_PROGRESS: ["ESCALATED", "RESOLVED"], ESCALATED: ["IN_PROGRESS", "RESOLVED"], RESOLVED: ["IN_PROGRESS"] };
/** Safety incidents and guest complaints can hold personal or sensitive detail: managers only, plus whoever raised or owns them. */
const SENSITIVE = new Set(["safety_or_facility", "guest_complaint"]);

/** Pure: may this member see this incident? */
export function canSeeIncident(membership, incident, email) {
  if (CAN.incidentsAll(membership)) return true;
  const me = normEmail(email);
  return CAN.incidentsCreate(membership) && (normEmail(incident.reportedByEmail) === me || normEmail(incident.assignedToEmail) === me);
}

const incidentView = (i, full) => ({ id: sid(i._id), ref: i.ref, locationId: sid(i.locationId), category: i.category, severity: i.severity, status: i.status, summary: i.summary, sensitive: SENSITIVE.has(i.category), ...(full ? { details: i.details || null, reservationId: sid(i.reservationId), contactId: sid(i.contactId), resolution: i.resolution || null, history: i.history || [] } : {}), assignedToEmail: i.assignedToEmail || null, reportedByEmail: i.reportedByEmail, createdAt: i.createdAt, resolvedAt: i.resolvedAt || null });

export async function createIncident({ orgId, membership, actorEmail, locationId, category, severity = "medium", summary, details, reservationId, assignedToEmail }) {
  if (!CAN.incidentsCreate(membership)) return fail("You don't have permission to record incidents.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  if (!INCIDENT_CATEGORIES.includes(category)) return fail(`Category must be one of: ${INCIDENT_CATEGORIES.join(", ")}.`);
  if (!INCIDENT_SEVERITIES.includes(severity)) return fail("Severity must be low, medium or high.");
  const s = clean(summary, 160);
  if (!s) return fail("Describe the incident in a line.");
  const c = await hcol();
  const org = toObjectId(orgId);
  let res = null;
  if (reservationId) { res = await c.findOne({ _id: oid(reservationId), orgId: org, kind: KINDS.reservation, locationId: got.location._id }); if (!res) return fail("That reservation wasn't found at this location.", 404); }
  const seq = await nextNumber(orgId, "incident");
  const doc = { orgId: org, kind: KINDS.incident, locationId: got.location._id, ref: `I-${String(seq).padStart(5, "0")}`, category, severity, status: "OPEN", summary: s, details: clean(details, 3000) || null, reservationId: res?._id || null, contactId: res?.contactId || null, assignedToEmail: normEmail(assignedToEmail) || null, reportedByEmail: actorEmail, date: nowIso().slice(0, 10), history: [{ at: nowIso(), by: actorEmail, to: "OPEN" }], createdAt: nowIso(), updatedAt: nowIso() };
  doc._id = (await c.insertOne(doc)).insertedId;
  await logH({ orgId, recordType: "INCIDENT", recordId: doc._id, actorEmail, action: "INCIDENT_RECORDED", metadata: { ref: doc.ref, category, severity, locationId: String(got.location._id) } });
  emitH(orgId, "incident.created", doc._id, { incident: { id: String(doc._id), ref: doc.ref, category, severity, locationId: String(got.location._id) } });
  // The notification says what kind of incident it is, never the detail (SOW 24: no personal information in previews).
  await notifyRoles({ orgId, locationId: got.location._id, roles: [], type: "incident", sourceId: doc._id, title: `New ${severity} incident: ${category.replace(/_/g, " ")}`, body: `${doc.ref} at ${got.location.name}. Open the incident for details.`, severity: severity === "high" ? "critical" : "warning" });
  return { incident: incidentView(doc, true) };
}

export async function listIncidents({ orgId, membership, actorEmail, locationId, status }) {
  if (!CAN.incidentsCreate(membership)) return fail("You don't have access to incidents.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const me = normEmail(actorEmail);
  const filter = { orgId: toObjectId(orgId), kind: KINDS.incident, locationId: got.location._id, ...(status ? { status } : {}) };
  if (!CAN.incidentsAll(membership)) filter.$or = [{ reportedByEmail: me }, { assignedToEmail: me }];
  const rows = await (await hcol()).find(filter).sort({ createdAt: -1 }).limit(300).toArray();
  return { incidents: rows.map((i) => incidentView(i, false)), categories: INCIDENT_CATEGORIES, severities: INCIDENT_SEVERITIES, states: INCIDENT_STATES };
}

async function loadIncident(orgId, membership, actorEmail, id) {
  const c = await hcol();
  const i = await c.findOne({ _id: oid(id), orgId: toObjectId(orgId), kind: KINDS.incident });
  if (!i) return fail("Incident not found.", 404);
  const got = await requireLocation(orgId, membership, i.locationId);
  if (got.error || !canSeeIncident(membership, i, actorEmail)) return fail("Incident not found.", 404);
  return { i, location: got.location };
}

export async function getIncident({ orgId, membership, actorEmail, id }) {
  const got = await loadIncident(orgId, membership, actorEmail, id);
  if (got.error) return got;
  if (SENSITIVE.has(got.i.category)) await logH({ orgId, recordType: "INCIDENT", recordId: got.i._id, actorEmail, action: "SENSITIVE_INCIDENT_VIEWED", metadata: { ref: got.i.ref } });
  return { incident: incidentView(got.i, true) };
}

export async function updateIncident({ orgId, membership, actorEmail, id, toStatus, note, resolution, assignedToEmail, severity }) {
  const got = await loadIncident(orgId, membership, actorEmail, id);
  if (got.error) return got;
  const { i } = got;
  const set = { updatedAt: nowIso() };
  const push = { at: nowIso(), by: actorEmail, note: clean(note, 500) || null };
  if (assignedToEmail !== undefined) { if (!CAN.incidentsAll(membership)) return fail("Only a manager can assign incidents.", 403); set.assignedToEmail = normEmail(assignedToEmail) || null; push.assignedTo = set.assignedToEmail; }
  if (severity !== undefined) { if (!INCIDENT_SEVERITIES.includes(severity)) return fail("Severity must be low, medium or high."); set.severity = severity; }
  if (toStatus !== undefined && toStatus !== i.status) {
    if (!(INCIDENT_TRANSITIONS[i.status] || []).includes(toStatus)) return fail(`An incident that is ${i.status.toLowerCase().replace(/_/g, " ")} can't be moved to ${String(toStatus).toLowerCase().replace(/_/g, " ")}.`, 409);
    if (toStatus === "RESOLVED") { const r = clean(resolution, 2000); if (!r) return fail("Describe how this was resolved."); set.resolution = r; set.resolvedAt = nowIso(); set.resolvedByEmail = actorEmail; }
    set.status = toStatus; push.from = i.status; push.to = toStatus;
  }
  await (await hcol()).updateOne({ _id: i._id }, { $set: set, $push: { history: push } });
  await logH({ orgId, recordType: "INCIDENT", recordId: i._id, actorEmail, action: set.status ? `INCIDENT_${set.status}` : "INCIDENT_UPDATED", previousState: i.status, newState: set.status || i.status, metadata: { ref: i.ref } });
  if (set.status === "ESCALATED") {
    emitH(orgId, "incident.escalated", `${i._id}:${Date.now()}`, { incident: { id: String(i._id), ref: i.ref, category: i.category, severity: set.severity || i.severity, locationId: String(i.locationId) } });
    await notifyRoles({ orgId, locationId: i.locationId, roles: [], type: "incident_escalated", sourceId: `${i._id}:esc`, title: "An incident has been escalated", body: `${i.ref}: ${i.category.replace(/_/g, " ")}.`, severity: "critical" });
  }
  return { incident: incidentView({ ...i, ...set, history: [...(i.history || []), push] }, true) };
}

/** Counts used by the overview (location-scoped). */
export async function operationsSummary(orgId, membership, locationIds, today) {
  const c = await hcol();
  const org = toObjectId(orgId);
  const [openIncidents, runs] = await Promise.all([
    CAN.incidentsAll(membership) ? c.countDocuments({ orgId: org, kind: KINDS.incident, locationId: { $in: locationIds }, status: { $ne: "RESOLVED" } }) : null,
    c.find({ orgId: org, kind: KINDS.checklistRun, locationId: { $in: locationIds }, date: today }).project({ status: 1, items: 1 }).toArray(),
  ]);
  return { openIncidents, checklistsToday: runs.length, checklistsCompleted: runs.filter((r) => r.status === "COMPLETED").length, checklistItemsOverdue: runs.reduce((n, r) => n + overdueItems(r).length, 0) };
}

export { allowedLocations, intIn };
