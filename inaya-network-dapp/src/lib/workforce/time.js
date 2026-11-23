// src/lib/workforce/time.js -- Commerce Phase 6 (Master SOW 10.3 time and attendance, 10.4 shift scheduling).
// Stored in `calendar_records` (production is at its collection limit):
//   w_punch       one clock event: CLOCK_IN | BREAK_START | BREAK_END | CLOCK_OUT, at a branch, idempotent (idem key)
//   w_correction  a missed/wrong punch fix requested by the employee or a manager; applied only after another manager approves
//   w_settings    per company: late grace minutes, weekly overtime threshold, max shift hours
//   w_template    a shift template (name, start/end time, role, branch)
//   w_shift       a scheduled shift (employee, branch, start, end, role) DRAFT -> PUBLISHED -> ACKNOWLEDGED; history kept
//   w_avail       an employee's availability / unavailability window
//   w_swap        a shift swap/cover request (requester -> taker) approved by a manager
//   w_need        staffing requirement per branch / weekday / hour band (for under/over-staffing indicators)
// Privacy (SOW 10.3): no covert tracking -- a punch stores only the branch chosen, time and the device's browser name; no GPS.
import { randomBytes } from "node:crypto";
import { getOrgCollections } from "../orgs.js";
import { ccol, oid, sid, clean, fail, nowIso, audit } from "../commerce/store.js";
import { allowedLocation, denyLocation, scopeFilter, memberLocations } from "./scope.js";
import { canManageOrg } from "../orgs.js";

export const K = { punch: "w_punch", corr: "w_correction", settings: "w_settings", tpl: "w_template", shift: "w_shift", avail: "w_avail", swap: "w_swap", need: "w_need" };
export const PUNCHES = ["CLOCK_IN", "BREAK_START", "BREAK_END", "CLOCK_OUT"];
const NEXT = { null: ["CLOCK_IN"], CLOCK_IN: ["BREAK_START", "CLOCK_OUT"], BREAK_START: ["BREAK_END"], BREAK_END: ["BREAK_START", "CLOCK_OUT"], CLOCK_OUT: ["CLOCK_IN"] };
export const DEFAULTS = { lateGraceMinutes: 5, weeklyOvertimeHours: 48, maxShiftHours: 12 };
const isMgr = (m) => canManageOrg(m) || m?.hrRole === "manager" || m?.commerceRole === "manager";
const H = 3600000;

let idx = null;
async function ensure() {
  if (idx) return idx; const c = await ccol();
  idx = Promise.all([
    c.createIndex({ orgId: 1, kind: 1, idem: 1 }, { unique: true, partialFilterExpression: { kind: K.punch }, name: "w_punch_idem" }),
    c.createIndex({ orgId: 1, kind: 1, email: 1, at: 1 }, { partialFilterExpression: { kind: { $in: [K.punch, K.shift] } }, name: "w_email_at" }),
  ]).catch((e) => { idx = null; throw e; });
  return idx;
}
export async function getTimeSettings(orgId) { const c = await ccol(); const s = await c.findOne({ orgId: oid(orgId), kind: K.settings }); return { ...DEFAULTS, ...(s?.settings || {}) }; }
export async function setTimeSettings({ orgId, membership, actorEmail, input = {} }) {
  if (!isMgr(membership)) return fail("Only a manager can change attendance settings.", 403);
  const s = { lateGraceMinutes: Math.max(0, Math.min(120, Math.floor(Number(input.lateGraceMinutes ?? DEFAULTS.lateGraceMinutes)))), weeklyOvertimeHours: Math.max(1, Math.min(100, Number(input.weeklyOvertimeHours ?? DEFAULTS.weeklyOvertimeHours))), maxShiftHours: Math.max(1, Math.min(24, Number(input.maxShiftHours ?? DEFAULTS.maxShiftHours))) };
  const c = await ccol(); await c.updateOne({ orgId: oid(orgId), kind: K.settings }, { $set: { settings: s, updatedAt: nowIso(), updatedBy: actorEmail } }, { upsert: true });
  await audit({ orgId, actorEmail, recordType: "WORKFORCE", recordId: oid(orgId), action: "TIME_SETTINGS_CHANGED", metadata: s });
  return { settings: s };
}

// ---------------------------------------------------------------- clock in / out
async function lastPunch(orgId, email) { const c = await ccol(); return c.findOne({ orgId: oid(orgId), kind: K.punch, email, voided: { $ne: true } }, { sort: { at: -1 } }); }
export async function myStatus({ orgId, membership }) {
  const p = await lastPunch(orgId, membership.email); const st = p?.type || null;
  return { state: st === "CLOCK_IN" || st === "BREAK_END" ? "WORKING" : st === "BREAK_START" ? "ON_BREAK" : "OFF", since: p?.at || null, locationId: p ? sid(p.locationId) : null, next: NEXT[st] || NEXT.null };
}
/** One punch. Duplicate-safe (the same idempotency key records once) and order-checked (no double clock-in, no break while off). */
export async function punch({ orgId, membership, type, locationId, idempotencyKey, device = null, note = null, now = new Date() }) {
  await ensure();
  if (!PUNCHES.includes(type)) return fail("Unknown time event.");
  if (!locationId || !allowedLocation(membership, locationId)) return denyLocation();
  const { warehouses } = await getOrgCollections(); if (!await warehouses.findOne({ _id: oid(locationId), orgId: oid(orgId) })) return fail("Branch not found.", 404);
  const idem = String(idempotencyKey || ""); if (!/^[A-Za-z0-9_-]{12,80}$/.test(idem)) return fail("Missing request key; reload and try again.");
  const c = await ccol(); const dup = await c.findOne({ orgId: oid(orgId), kind: K.punch, idem }); if (dup) return { punch: punchView(dup), duplicate: true };
  const last = await lastPunch(orgId, membership.email); const allowed = NEXT[last?.type || null] || NEXT.null;
  if (!allowed.includes(type)) return fail(`You can't ${type.replace("_", " ").toLowerCase()} now (last: ${last ? last.type.replace("_", " ").toLowerCase() : "nothing yet"}).`, 409, "PUNCH_ORDER");
  if (["BREAK_START", "BREAK_END", "CLOCK_OUT"].includes(type) && last && sid(last.locationId) !== String(locationId)) return fail("Finish at the branch where you clocked in.", 409);
  const doc = { orgId: oid(orgId), kind: K.punch, email: membership.email, type, locationId: oid(locationId), at: now.toISOString(), idem, device: device ? clean(device, 120) : null, note: note ? clean(note, 300) : null, source: "self", createdAt: nowIso() };
  try { const r = await c.insertOne(doc); doc._id = r.insertedId; } catch (e) { if (e?.code === 11000) { const d = await c.findOne({ orgId: oid(orgId), kind: K.punch, idem }); return { punch: punchView(d), duplicate: true }; } throw e; }
  return { punch: punchView(doc) };
}
const punchView = (p) => ({ id: sid(p._id), email: p.email, type: p.type, locationId: sid(p.locationId), at: p.at, source: p.source, note: p.note || null, voided: !!p.voided });

// ---------------------------------------------------------------- corrections (only authorised people; approved by a different manager)
export async function requestCorrection({ orgId, membership, actorEmail, input = {} }) {
  const email = String(input.email || membership.email).toLowerCase(); const self = email === String(membership.email).toLowerCase();
  if (!self && !isMgr(membership)) return fail("Only a manager can correct someone else's time.", 403);
  const action = input.action; if (!["ADD", "VOID", "MOVE"].includes(action)) return fail("Choose add, remove or move a time event.");
  const reason = clean(input.reason, 300); if (reason.length < 5) return fail("Give a reason for the correction.");
  const c = await ccol(); let target = null;
  if (action !== "ADD") { target = await c.findOne({ _id: oid(input.punchId), orgId: oid(orgId), kind: K.punch, email }); if (!target) return fail("Time event not found.", 404); }
  const at = action === "VOID" ? null : new Date(input.at); if (action !== "VOID" && Number.isNaN(at?.getTime())) return fail("Enter the correct date and time.");
  if (action === "ADD" && !PUNCHES.includes(input.type)) return fail("Choose the event type to add.");
  const loc = action === "ADD" ? input.locationId : sid(target.locationId); if (!allowedLocation(membership, loc) && !self) return denyLocation();
  const doc = { orgId: oid(orgId), kind: K.corr, email, action, punchId: target?._id || null, type: action === "ADD" ? input.type : target.type, at: at ? at.toISOString() : null, locationId: oid(loc), reason, status: "PENDING", requestedBy: actorEmail, createdAt: nowIso() };
  const r = await c.insertOne(doc); await audit({ orgId, actorEmail, recordType: "TIME_CORRECTION", recordId: r.insertedId, action: "TIME_CORRECTION_REQUESTED", metadata: { email, action, reason } });
  return { correction: { id: sid(r.insertedId), ...doc, _id: undefined, orgId: undefined } };
}
export async function decideCorrection({ orgId, membership, actorEmail, id, approve, note }) {
  if (!isMgr(membership)) return fail("Only a manager can approve time corrections.", 403);
  const c = await ccol(); const x = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: K.corr, status: "PENDING" }); if (!x) return fail("Correction not found or already decided.", 404);
  if ([x.requestedBy, x.email].map((e) => String(e).toLowerCase()).includes(String(actorEmail).toLowerCase())) return fail("Someone else must approve this correction (not the requester or the employee).", 403, "SELF_APPROVAL");
  if (!allowedLocation(membership, x.locationId)) return denyLocation();
  const claimed = await c.findOneAndUpdate({ _id: x._id, status: "PENDING" }, { $set: { status: approve ? "APPROVED" : "REJECTED", decidedBy: actorEmail, decidedAt: nowIso(), decisionNote: clean(note, 300) || null } }); if (!claimed) return fail("Already decided.", 409);
  if (approve) {
    if (x.action === "ADD") await c.insertOne({ orgId: x.orgId, kind: K.punch, email: x.email, type: x.type, locationId: x.locationId, at: x.at, idem: `corr_${sid(x._id)}`, source: "correction", correctionId: x._id, note: x.reason, createdAt: nowIso() });
    else if (x.action === "VOID") await c.updateOne({ _id: x.punchId }, { $set: { voided: true, voidedBy: actorEmail, voidCorrectionId: x._id } });
    else await c.updateOne({ _id: x.punchId }, { $set: { at: x.at, movedBy: actorEmail, moveCorrectionId: x._id }, $push: { history: { at: nowIso(), by: actorEmail, reason: x.reason } } });
  }
  await audit({ orgId, actorEmail, recordType: "TIME_CORRECTION", recordId: x._id, action: approve ? "TIME_CORRECTION_APPROVED" : "TIME_CORRECTION_REJECTED", metadata: { email: x.email, action: x.action } });
  return { ok: true };
}
export async function listCorrections({ orgId, membership, status = "PENDING" }) {
  const c = await ccol(); const q = { orgId: oid(orgId), kind: K.corr, ...(status ? { status } : {}), ...(isMgr(membership) ? scopeFilter(membership, "locationId") : { email: membership.email }) };
  return { corrections: (await c.find(q).sort({ createdAt: -1 }).limit(300).toArray()).map((x) => ({ id: sid(x._id), email: x.email, action: x.action, type: x.type, at: x.at, locationId: sid(x.locationId), reason: x.reason, status: x.status, requestedBy: x.requestedBy, decidedBy: x.decidedBy || null })) };
}

// ---------------------------------------------------------------- timesheets (worked hours, breaks, lateness, overtime inputs)
/** Pairs punches into worked intervals per day. Open shifts (no clock-out) are flagged as exceptions, never guessed. */
export function computeTimesheet(punches, shifts = [], settings = DEFAULTS) {
  const sorted = [...punches].filter((p) => !p.voided).sort((a, b) => (a.at < b.at ? -1 : 1));
  const days = new Map(); let open = null, onBreak = null, brk = 0; const exceptions = [];
  const day = (iso) => iso.slice(0, 10); const get = (d) => days.get(d) || days.set(d, { date: d, workedMs: 0, breakMs: 0, punches: [], late: false, lateMinutes: 0, leftEarly: false }).get(d);
  for (const p of sorted) {
    const d = get(day(p.at)); d.punches.push({ type: p.type, at: p.at, locationId: String(p.locationId) });
    const t = Date.parse(p.at);
    if (p.type === "CLOCK_IN") { if (open) exceptions.push({ date: day(open.at), kind: "MISSING_CLOCK_OUT" }); open = p; onBreak = null; brk = 0; }
    else if (p.type === "BREAK_START" && open) { onBreak = t; }
    else if (p.type === "BREAK_END" && open && onBreak) { get(day(open.at)).breakMs += t - onBreak; brk += t - onBreak; onBreak = null; }
    else if (p.type === "CLOCK_OUT" && open) { const st = Date.parse(open.at); const dd = get(day(open.at)); dd.workedMs += t - st - brk - (onBreak ? t - onBreak : 0); if (t - st > settings.maxShiftHours * H) exceptions.push({ date: dd.date, kind: "LONG_SHIFT" }); open = null; onBreak = null; brk = 0; }
  }
  if (open) exceptions.push({ date: day(open.at), kind: "STILL_CLOCKED_IN" });
  for (const s of shifts) { // lateness and early leaving against the published schedule
    const d = days.get(s.start.slice(0, 10)); if (!d) { if (Date.parse(s.start) < Date.now()) exceptions.push({ date: s.start.slice(0, 10), kind: "NO_SHOW" }); continue; }
    const firstIn = d.punches.find((p) => p.type === "CLOCK_IN"); const lastOut = [...d.punches].reverse().find((p) => p.type === "CLOCK_OUT");
    if (firstIn) { const late = (Date.parse(firstIn.at) - Date.parse(s.start)) / 60000; if (late > settings.lateGraceMinutes) { d.late = true; d.lateMinutes = Math.round(late); } }
    if (lastOut && Date.parse(lastOut.at) < Date.parse(s.end) - settings.lateGraceMinutes * 60000) d.leftEarly = true;
    d.scheduledMs = (d.scheduledMs || 0) + (Date.parse(s.end) - Date.parse(s.start));
  }
  const rows = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({ ...d, workedHours: Math.round(d.workedMs / H * 100) / 100, breakHours: Math.round(d.breakMs / H * 100) / 100, scheduledHours: d.scheduledMs ? Math.round(d.scheduledMs / H * 100) / 100 : 0 }));
  const total = rows.reduce((n, r) => n + r.workedHours, 0);
  return { days: rows, totalHours: Math.round(total * 100) / 100, overtimeHours: Math.max(0, Math.round((total - settings.weeklyOvertimeHours) * 100) / 100), exceptions };
}
export async function timesheet({ orgId, membership, email, from, to }) {
  const who = String(email || membership.email).toLowerCase(); if (who !== String(membership.email).toLowerCase() && !isMgr(membership)) return fail("You can only see your own timesheet.", 403);
  const f = new Date(from || Date.now() - 7 * 86400000), t = new Date(to || Date.now()); const c = await ccol(); const settings = await getTimeSettings(orgId);
  const scope = who === String(membership.email).toLowerCase() ? {} : scopeFilter(membership, "locationId");
  const punches = await c.find({ orgId: oid(orgId), kind: K.punch, email: who, at: { $gte: f.toISOString(), $lte: t.toISOString() }, ...scope }).sort({ at: 1 }).toArray();
  const shifts = await c.find({ orgId: oid(orgId), kind: K.shift, email: who, status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] }, start: { $gte: f.toISOString(), $lte: t.toISOString() } }).toArray();
  return { email: who, from: f.toISOString(), to: t.toISOString(), ...computeTimesheet(punches, shifts, settings), settings };
}
/** CSV for payroll: one row per person per day (hours, breaks, lateness, overtime flag). */
export async function payrollExport({ orgId, membership, from, to }) {
  if (!isMgr(membership)) return fail("Only a manager can export timesheets.", 403);
  const c = await ccol(); const f = new Date(from), t = new Date(to); if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return fail("Choose a date range.");
  const emails = await c.distinct("email", { orgId: oid(orgId), kind: K.punch, at: { $gte: f.toISOString(), $lte: t.toISOString() }, ...scopeFilter(membership, "locationId") });
  const lines = [["email", "date", "worked_hours", "break_hours", "scheduled_hours", "late_minutes", "left_early"].join(",")]; let exceptions = 0;
  for (const e of emails.sort()) { const ts = await timesheet({ orgId, membership, email: e, from: f, to: t }); exceptions += ts.exceptions.length; for (const d of ts.days) lines.push([e, d.date, d.workedHours, d.breakHours, d.scheduledHours, d.lateMinutes, d.leftEarly ? "yes" : "no"].join(",")); }
  return { csv: lines.join("\n") + "\n", people: emails.length, exceptions };
}

// ---------------------------------------------------------------- scheduling
const shiftView = (s) => ({ id: sid(s._id), email: s.email, locationId: sid(s.locationId), start: s.start, end: s.end, role: s.role || null, status: s.status, acknowledgedAt: s.acknowledgedAt || null, note: s.note || null, history: s.history || [] });
export async function saveTemplate({ orgId, membership, actorEmail, input = {} }) {
  if (!isMgr(membership)) return fail("Only a manager can edit shift templates.", 403);
  const name = clean(input.name, 60); if (name.length < 2) return fail("Name the template (e.g. Morning).");
  if (!/^\d{2}:\d{2}$/.test(input.startTime || "") || !/^\d{2}:\d{2}$/.test(input.endTime || "")) return fail("Times are HH:MM.");
  const c = await ccol(); const doc = { name, startTime: input.startTime, endTime: input.endTime, role: clean(input.role, 40) || null, locationId: input.locationId ? oid(input.locationId) : null, updatedAt: nowIso() };
  if (input.id) await c.updateOne({ _id: oid(input.id), orgId: oid(orgId), kind: K.tpl }, { $set: doc }); else await c.insertOne({ orgId: oid(orgId), kind: K.tpl, ...doc, createdBy: actorEmail, createdAt: nowIso() });
  return { templates: (await c.find({ orgId: oid(orgId), kind: K.tpl }).sort({ startTime: 1 }).toArray()).map((t) => ({ id: sid(t._id), name: t.name, startTime: t.startTime, endTime: t.endTime, role: t.role, locationId: sid(t.locationId) })) };
}
/** Checks before a shift is saved: branch permission, the person's branches, overlap, approved leave, max length, weekly overtime. */
async function shiftChecks(orgId, s, ignoreId = null) {
  const warnings = []; const c = await ccol(); const settings = await getTimeSettings(orgId);
  const len = (Date.parse(s.end) - Date.parse(s.start)) / H; if (!(len > 0)) return { error: "The shift must end after it starts." };
  if (len > settings.maxShiftHours) warnings.push(`Longer than ${settings.maxShiftHours} hours.`);
  const overlap = await c.findOne({ orgId: oid(orgId), kind: K.shift, email: s.email, status: { $ne: "CANCELLED" }, ...(ignoreId ? { _id: { $ne: ignoreId } } : {}), start: { $lt: s.end }, end: { $gt: s.start } });
  if (overlap) return { error: `${s.email} already has a shift then.` };
  const { orgMembers, leaveRequests, employees } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: oid(orgId), email: s.email, status: "active" }); if (!m) return { error: "That person isn't an active member." };
  if (!allowedLocation(m, s.locationId)) return { error: `${s.email} isn't assigned to that branch.` };
  const emp = await employees.findOne({ orgId: oid(orgId), memberEmail: s.email });
  if (emp) { const leave = await leaveRequests.findOne({ orgId: oid(orgId), employeeId: emp._id, status: "APPROVED", startDate: { $lte: s.end.slice(0, 10) }, endDate: { $gte: s.start.slice(0, 10) } }); if (leave) return { error: `${s.email} is on approved leave then.` }; }
  const unav = await c.findOne({ orgId: oid(orgId), kind: K.avail, email: s.email, available: false, start: { $lt: s.end }, end: { $gt: s.start } }); if (unav) warnings.push(`${s.email} marked themselves unavailable then.`);
  const wk = new Date(s.start); wk.setUTCDate(wk.getUTCDate() - ((wk.getUTCDay() + 6) % 7)); wk.setUTCHours(0, 0, 0, 0); const wkEnd = new Date(wk.getTime() + 7 * 86400000);
  const week = await c.find({ orgId: oid(orgId), kind: K.shift, email: s.email, status: { $ne: "CANCELLED" }, start: { $gte: wk.toISOString(), $lt: wkEnd.toISOString() }, ...(ignoreId ? { _id: { $ne: ignoreId } } : {}) }).toArray();
  const hours = week.reduce((n, x) => n + (Date.parse(x.end) - Date.parse(x.start)) / H, 0) + len; if (hours > settings.weeklyOvertimeHours) warnings.push(`${Math.round(hours)} hours this week: over the ${settings.weeklyOvertimeHours}-hour overtime threshold.`);
  return { warnings };
}
export async function saveShift({ orgId, membership, actorEmail, input = {} }) {
  if (!isMgr(membership)) return fail("Only a manager can schedule shifts.", 403);
  if (!allowedLocation(membership, input.locationId)) return denyLocation();
  const s = { email: String(input.email || "").toLowerCase(), locationId: oid(input.locationId), start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString(), role: clean(input.role, 40) || null, note: clean(input.note, 300) || null };
  if (!s.email || !s.locationId) return fail("Choose a person and a branch.");
  const c = await ccol(); const existing = input.id ? await c.findOne({ _id: oid(input.id), orgId: oid(orgId), kind: K.shift }) : null; if (input.id && !existing) return fail("Shift not found.", 404);
  const chk = await shiftChecks(orgId, { ...s, locationId: sid(s.locationId) }, existing?._id || null); if (chk.error) return fail(chk.error, 409, "SHIFT_CONFLICT");
  const now = nowIso();
  if (existing) { await c.updateOne({ _id: existing._id }, { $set: { ...s, status: existing.status === "DRAFT" ? "DRAFT" : "PUBLISHED", acknowledgedAt: null, updatedAt: now }, $push: { history: { at: now, by: actorEmail, change: "edited", from: { start: existing.start, end: existing.end, email: existing.email } } } }); }
  else { const r = await c.insertOne({ orgId: oid(orgId), kind: K.shift, ...s, status: "DRAFT", history: [{ at: now, by: actorEmail, change: "created" }], createdBy: actorEmail, createdAt: now }); input.id = sid(r.insertedId); }
  return { shift: shiftView(await c.findOne({ _id: oid(input.id) })), warnings: chk.warnings };
}
export async function publishWeek({ orgId, membership, actorEmail, locationId, weekStart }) {
  if (!isMgr(membership)) return fail("Only a manager can publish the rota.", 403); if (!allowedLocation(membership, locationId)) return denyLocation();
  const f = new Date(weekStart); const t = new Date(f.getTime() + 7 * 86400000); const c = await ccol(); const now = nowIso();
  const r = await c.updateMany({ orgId: oid(orgId), kind: K.shift, locationId: oid(locationId), status: "DRAFT", start: { $gte: f.toISOString(), $lt: t.toISOString() } }, { $set: { status: "PUBLISHED", publishedAt: now, publishedBy: actorEmail }, $push: { history: { at: now, by: actorEmail, change: "published" } } });
  await audit({ orgId, actorEmail, recordType: "ROTA", recordId: oid(locationId), action: "ROTA_PUBLISHED", metadata: { weekStart: f.toISOString().slice(0, 10), shifts: r.modifiedCount } });
  return { published: r.modifiedCount };
}
export async function acknowledgeShift({ orgId, membership, id }) {
  const c = await ccol(); const r = await c.findOneAndUpdate({ _id: oid(id), orgId: oid(orgId), kind: K.shift, email: membership.email, status: "PUBLISHED" }, { $set: { status: "ACKNOWLEDGED", acknowledgedAt: nowIso() }, $push: { history: { at: nowIso(), by: membership.email, change: "acknowledged" } } }, { returnDocument: "after" });
  return r ? { shift: shiftView(r) } : fail("Shift not found or not yours to acknowledge.", 404);
}
export async function cancelShift({ orgId, membership, actorEmail, id, reason }) {
  if (!isMgr(membership)) return fail("Only a manager can cancel shifts.", 403);
  const c = await ccol(); const s = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: K.shift }); if (!s) return fail("Shift not found.", 404); if (!allowedLocation(membership, s.locationId)) return denyLocation();
  await c.updateOne({ _id: s._id }, { $set: { status: "CANCELLED" }, $push: { history: { at: nowIso(), by: actorEmail, change: "cancelled", reason: clean(reason, 200) } } }); return { ok: true };
}
export async function rota({ orgId, membership, locationId, weekStart }) {
  if (locationId && !allowedLocation(membership, locationId)) return denyLocation();
  const f = new Date(weekStart || Date.now()); f.setUTCHours(0, 0, 0, 0); const t = new Date(f.getTime() + 7 * 86400000); const c = await ccol();
  const mgr = isMgr(membership);
  const q = { orgId: oid(orgId), kind: K.shift, status: { $ne: "CANCELLED" }, start: { $gte: f.toISOString(), $lt: t.toISOString() }, ...(locationId ? { locationId: oid(locationId) } : scopeFilter(membership, "locationId")), ...(mgr ? {} : { email: membership.email, status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] } }) };
  const shifts = (await c.find(q).sort({ start: 1 }).toArray()).map(shiftView);
  const needs = locationId ? await c.find({ orgId: oid(orgId), kind: K.need, locationId: oid(locationId) }).toArray() : [];
  const coverage = needs.map((n) => { const out = []; for (let d = 0; d < 7; d++) { const day = new Date(f.getTime() + d * 86400000); if (day.getUTCDay() !== n.weekday) continue; const from = new Date(day); from.setUTCHours(n.fromHour, 0, 0, 0); const to = new Date(day); to.setUTCHours(n.toHour, 0, 0, 0); const staffed = shifts.filter((s) => s.start < to.toISOString() && s.end > from.toISOString()).length; out.push({ date: day.toISOString().slice(0, 10), fromHour: n.fromHour, toHour: n.toHour, needed: n.staff, staffed, state: staffed < n.staff ? "UNDERSTAFFED" : staffed > n.staff + 1 ? "OVERSTAFFED" : "OK" }); } return out; }).flat();
  return { weekStart: f.toISOString().slice(0, 10), shifts, coverage };
}
export async function setNeed({ orgId, membership, actorEmail, input = {} }) {
  if (!isMgr(membership)) return fail("Only a manager can set staffing needs.", 403); if (!allowedLocation(membership, input.locationId)) return denyLocation();
  const n = { weekday: Math.floor(Number(input.weekday)), fromHour: Math.floor(Number(input.fromHour)), toHour: Math.floor(Number(input.toHour)), staff: Math.floor(Number(input.staff)) };
  if (!(n.weekday >= 0 && n.weekday <= 6 && n.fromHour >= 0 && n.toHour <= 24 && n.toHour > n.fromHour && n.staff >= 0 && n.staff <= 100)) return fail("Check the day, hours and number of staff.");
  const c = await ccol(); await c.updateOne({ orgId: oid(orgId), kind: K.need, locationId: oid(input.locationId), weekday: n.weekday, fromHour: n.fromHour }, { $set: { ...n, updatedBy: actorEmail, updatedAt: nowIso() } }, { upsert: true }); return { ok: true };
}
export async function setAvailability({ orgId, membership, input = {} }) {
  const start = new Date(input.start), end = new Date(input.end); if (!(end > start)) return fail("Choose a time window.");
  const c = await ccol(); await c.insertOne({ orgId: oid(orgId), kind: K.avail, email: membership.email, start: start.toISOString(), end: end.toISOString(), available: input.available !== false, note: clean(input.note, 200) || null, createdAt: nowIso() }); return { ok: true };
}
/** Swap / cover: the shift owner asks; the taker must be at that branch; a manager approves (not the owner or taker). */
export async function requestSwap({ orgId, membership, input = {} }) {
  const c = await ccol(); const s = await c.findOne({ _id: oid(input.shiftId), orgId: oid(orgId), kind: K.shift, email: membership.email, status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] } }); if (!s) return fail("Shift not found.", 404);
  const to = String(input.toEmail || "").toLowerCase(); if (!to || to === membership.email) return fail("Choose who should take the shift.");
  const r = await c.insertOne({ orgId: oid(orgId), kind: K.swap, shiftId: s._id, fromEmail: membership.email, toEmail: to, locationId: s.locationId, status: "PENDING", reason: clean(input.reason, 200) || null, createdAt: nowIso() }); return { swap: { id: sid(r.insertedId), status: "PENDING" } };
}
export async function decideSwap({ orgId, membership, actorEmail, id, approve }) {
  if (!isMgr(membership)) return fail("Only a manager can approve swaps.", 403);
  const c = await ccol(); const w = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: K.swap, status: "PENDING" }); if (!w) return fail("Swap not found.", 404);
  if ([w.fromEmail, w.toEmail].includes(String(actorEmail).toLowerCase())) return fail("A manager not involved in the swap must approve it.", 403, "SELF_APPROVAL");
  if (!allowedLocation(membership, w.locationId)) return denyLocation();
  if (approve) { const s = await c.findOne({ _id: w.shiftId }); const chk = await shiftChecks(orgId, { email: w.toEmail, locationId: sid(s.locationId), start: s.start, end: s.end }, s._id); if (chk.error) return fail(chk.error, 409, "SHIFT_CONFLICT"); await c.updateOne({ _id: s._id }, { $set: { email: w.toEmail, status: "PUBLISHED", acknowledgedAt: null }, $push: { history: { at: nowIso(), by: actorEmail, change: "swapped", from: w.fromEmail, to: w.toEmail } } }); }
  await c.updateOne({ _id: w._id }, { $set: { status: approve ? "APPROVED" : "REJECTED", decidedBy: actorEmail, decidedAt: nowIso() } });
  await audit({ orgId, actorEmail, recordType: "ROTA", recordId: w.shiftId, action: approve ? "SHIFT_SWAP_APPROVED" : "SHIFT_SWAP_REJECTED", metadata: { from: w.fromEmail, to: w.toEmail } });
  return { ok: true };
}
export async function rotaCsv({ orgId, membership, locationId, weekStart }) {
  const r = await rota({ orgId, membership, locationId, weekStart }); if (r.error) return r;
  return { csv: ["email,branch,start,end,role,status", ...r.shifts.map((s) => [s.email, s.locationId, s.start, s.end, s.role || "", s.status].join(","))].join("\n") + "\n" };
}
export const newKey = () => `wf_${randomBytes(12).toString("hex")}`;
export { isMgr, memberLocations };
