// src/lib/engagement/appointments.js
//
// Appointment Calendar SOW — the calendar engine: org settings, staff
// availability, appointment types, appointments and their lifecycle
// (book, confirm, reschedule, cancel, complete, no-show), notes and
// attachments, CRM linking, meeting links (Inaya Meet or a URL), reminders
// scheduling, notifications and workflow events.
//
// Everything is stored in calendar_records (see store.js).

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { sendEmail } from "../email.js";
import { buildInvite } from "../ics.js";
import { createNotification } from "../notifications.js";
import { logOrgActivity } from "../org-activity-log.js";
import { logActivity } from "../crm-activity.js";
import {
  engagementCollections, ensureEngagementIndexes, oid, nowIso, normEmail, isEmail, fail, clean,
  canManageCalendar, canActForStaff, sharesDepartment, getMemberByEmail, listOrgMembers,
} from "./store.js";
import { seal, openSafe } from "./crypto.js";
import { isValidTimeZone } from "./time.js";
import { DEFAULT_WEEKLY, normalizeWeekly, normalizeTypeRules, computeSlots, pickRoundRobin } from "./availability.js";
import * as MSG from "./messages.js";

export const STATUSES = ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"];
const ACTIVE = ["PENDING", "CONFIRMED"];
export const LOCATION_KINDS = ["inaya_meet", "video_url", "phone", "in_person"];
export const USE_CASES = {
  healthcare: { label: "Healthcare: patient visits", typeName: "Patient consultation", durationMinutes: 20, location: "in_person" },
  legal: { label: "Legal: client consultations", typeName: "Client consultation", durationMinutes: 45, location: "inaya_meet" },
  financial: { label: "Financial advisory meetings", typeName: "Advisory meeting", durationMinutes: 60, location: "inaya_meet" },
  education: { label: "Education: parent meetings", typeName: "Parent-teacher meeting", durationMinutes: 15, location: "in_person" },
  sales: { label: "Enterprise sales meetings", typeName: "Discovery call", durationMinutes: 30, location: "inaya_meet" },
  general: { label: "General", typeName: "Meeting", durationMinutes: 30, location: "inaya_meet" },
};
const TRANSITIONS = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["COMPLETED", "NO_SHOW", "CANCELLED"],
  COMPLETED: [], CANCELLED: [], NO_SHOW: ["COMPLETED"],
};

export const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
const emitEvent = (orgId, key, appt, extra = {}) =>
  import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId, type: "event", key, eventId: `${key}:${appt._id}:${appt.sequence || 0}`, payload: { appointment: publicAppointment(appt), ...extra } })).catch(() => {});

// ------------------------------------------------------------------ settings

export const SETTINGS_DEFAULTS = {
  businessName: "", replyToEmail: "", reminderOffsetsMinutes: [1440, 60], smsReminders: false,
  notifyStaffByEmail: true, defaultDepartmentId: null, enquiryWelcome: true, enquiryWelcomeMessage: "",
  followUpSequenceId: null, postMeetingPromptMinutes: 30,
};

export async function getCalendarSettings(orgId) {
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  const doc = await calendar.findOne({ orgId: toObjectId(orgId), kind: "settings" });
  let businessName = doc?.businessName;
  if (!businessName) { const { orgs } = await getOrgCollections(); businessName = (await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1 } }))?.name || "Our team"; }
  const { _id, orgId: _o, kind, ...rest } = doc || {};
  return { ...SETTINGS_DEFAULTS, ...rest, businessName };
}

export async function updateCalendarSettings({ orgId, membership, actorEmail, updates = {} }) {
  if (!canManageCalendar(membership)) return fail("Only a calendar manager, admin or owner can change calendar settings.", 403);
  const set = {};
  if (updates.businessName !== undefined) set.businessName = clean(updates.businessName, 120);
  if (updates.replyToEmail !== undefined) { const e = normEmail(updates.replyToEmail); if (e && !isEmail(e)) return fail("Reply-to must be an email address."); set.replyToEmail = e; }
  if (updates.reminderOffsetsMinutes !== undefined) {
    const arr = (Array.isArray(updates.reminderOffsetsMinutes) ? updates.reminderOffsetsMinutes : []).map(Number);
    if (arr.length > 4 || arr.some((n) => !Number.isInteger(n) || n < 5 || n > 60 * 24 * 14)) return fail("Up to 4 reminders, each 5 minutes to 14 days before.");
    set.reminderOffsetsMinutes = [...new Set(arr)].sort((a, b) => b - a);
  }
  for (const k of ["smsReminders", "notifyStaffByEmail", "enquiryWelcome"]) if (updates[k] !== undefined) set[k] = updates[k] === true;
  if (updates.enquiryWelcomeMessage !== undefined) set.enquiryWelcomeMessage = clean(updates.enquiryWelcomeMessage, 1000);
  if (updates.postMeetingPromptMinutes !== undefined) { const n = Number(updates.postMeetingPromptMinutes); if (!Number.isInteger(n) || n < 0 || n > 1440) return fail("Post-meeting prompt must be 0 to 1440 minutes."); set.postMeetingPromptMinutes = n; }
  if (updates.defaultDepartmentId !== undefined) {
    if (updates.defaultDepartmentId === null) set.defaultDepartmentId = null;
    else { const { departments } = await getOrgCollections(); const d = oid(updates.defaultDepartmentId) && await departments.findOne({ _id: oid(updates.defaultDepartmentId), orgId: toObjectId(orgId) }); if (!d) return fail("Department not found.", 404); set.defaultDepartmentId = d._id; }
  }
  if (updates.followUpSequenceId !== undefined) set.followUpSequenceId = updates.followUpSequenceId ? oid(updates.followUpSequenceId) : null;
  const { calendar } = await engagementCollections();
  await calendar.updateOne({ orgId: toObjectId(orgId), kind: "settings" }, { $set: { ...set, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { orgId: toObjectId(orgId), kind: "settings", createdAt: nowIso() } }, { upsert: true });
  return { settings: await getCalendarSettings(orgId) };
}

// -------------------------------------------------------------- availability

function availabilityView(doc, staffEmail) {
  return {
    staffEmail: doc?.staffEmail || staffEmail, timeZone: doc?.timeZone || "UTC", weekly: doc?.weekly || DEFAULT_WEEKLY,
    timeOff: (doc?.timeOff || []).filter((t) => new Date(t.end) > new Date()),
    calendarImport: doc?.importUrlSealed ? { connected: true, lastSyncAt: doc.importedAt || null, lastError: doc.importError || null, busyBlocks: (doc.importedBusy || []).length } : { connected: false },
    feed: { enabled: !!doc?.feedTokenHash },
    bookable: doc?.bookable !== false,
  };
}

export async function getAvailabilityDoc(orgId, staffEmail) {
  const { calendar } = await engagementCollections();
  return calendar.findOne({ orgId: toObjectId(orgId), kind: "availability", staffEmail: normEmail(staffEmail) });
}

export async function getAvailability({ orgId, membership, staffEmail }) {
  const email = normEmail(staffEmail || membership.email);
  if (!canActForStaff(membership, email)) return fail("You can only see your own availability.", 403);
  return { availability: availabilityView(await getAvailabilityDoc(orgId, email), email) };
}

export async function saveAvailability({ orgId, membership, actorEmail, staffEmail, timeZone, weekly, timeOff, bookable }) {
  await ensureEngagementIndexes();
  const email = normEmail(staffEmail || membership.email);
  if (!canActForStaff(membership, email)) return fail("You can only change your own availability.", 403);
  if (email !== normEmail(membership.email) && !(await getMemberByEmail(orgId, email))) return fail("That person isn't a member of this company.", 404);
  const set = { updatedAt: nowIso(), updatedBy: actorEmail };
  if (timeZone !== undefined) { if (!isValidTimeZone(timeZone)) return fail("Choose a valid time zone (for example Asia/Karachi)."); set.timeZone = timeZone; }
  if (weekly !== undefined) { const w = normalizeWeekly(weekly); if (w.error) return fail(w.error); set.weekly = w.weekly; }
  if (timeOff !== undefined) {
    if (!Array.isArray(timeOff) || timeOff.length > 100) return fail("Time off must be a list (100 entries at most).");
    const out = [];
    for (const t of timeOff) {
      const s = new Date(t?.start), e = new Date(t?.end);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return fail("Each time-off entry needs a start before its end.");
      out.push({ start: s.toISOString(), end: e.toISOString(), reason: clean(t.reason, 120) });
    }
    set.timeOff = out;
  }
  if (bookable !== undefined) set.bookable = bookable !== false;
  const { calendar } = await engagementCollections();
  await calendar.updateOne({ orgId: toObjectId(orgId), kind: "availability", staffEmail: email },
    { $set: set, $setOnInsert: { orgId: toObjectId(orgId), kind: "availability", staffEmail: email, createdAt: nowIso(), ...(set.timeZone ? {} : { timeZone: "UTC" }), ...(set.weekly ? {} : { weekly: DEFAULT_WEEKLY }) } }, { upsert: true });
  return { availability: availabilityView(await getAvailabilityDoc(orgId, email), email) };
}

// --------------------------------------------------------- appointment types

function typeView(t) {
  if (!t) return null;
  const { orgId, kind, ...rest } = t;
  return { ...rest, id: String(t._id) };
}

export async function listTypes(orgId, { includeArchived = false } = {}) {
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  const q = { orgId: toObjectId(orgId), kind: "type", ...(includeArchived ? {} : { archived: { $ne: true } }) };
  return { types: (await calendar.find(q).sort({ name: 1 }).limit(200).toArray()).map(typeView) };
}

async function validateType(orgId, input, existing = {}) {
  const name = input.name !== undefined ? clean(input.name, 80) : existing.name;
  if (!name) return fail("Give the appointment type a name.");
  const r = normalizeTypeRules({ ...existing, ...input });
  if (r.error) return fail(r.error);
  const location = input.location !== undefined ? input.location : existing.location || "inaya_meet";
  if (!LOCATION_KINDS.includes(location)) return fail(`Location must be one of: ${LOCATION_KINDS.join(", ")}.`);
  const locationDetail = input.locationDetail !== undefined ? clean(input.locationDetail, 300) : existing.locationDetail || "";
  if (location === "video_url" && !/^https:\/\/\S+$/i.test(locationDetail)) return fail("Add the https meeting link for a video-link type.");
  if (location === "in_person" && !locationDetail) return fail("Add the address for an in-person type.");
  let staffEmails = input.staffEmails !== undefined ? [...new Set((input.staffEmails || []).map(normEmail).filter(Boolean))] : existing.staffEmails || [];
  if (!staffEmails.length) return fail("Choose at least one team member who takes this appointment.");
  if (staffEmails.length > 50) return fail("50 team members at most per type.");
  const members = new Set((await listOrgMembers(orgId)).map((m) => normEmail(m.email)));
  const missing = staffEmails.filter((e) => !members.has(e));
  if (missing.length) return fail(`Not members of this company: ${missing.join(", ")}.`);
  const assignment = (input.assignment ?? existing.assignment ?? "choose");
  if (!["choose", "round_robin"].includes(assignment)) return fail("Assignment must be choose or round_robin.");
  const useCase = input.useCase ?? existing.useCase ?? "general";
  if (!USE_CASES[useCase]) return fail("Unknown use case.");
  const questions = input.questions !== undefined ? (Array.isArray(input.questions) ? input.questions : []).slice(0, 10).map((q) => ({ id: clean(q.id, 40) || randomUUID().slice(0, 8), label: clean(q.label, 200), required: q.required === true })).filter((q) => q.label) : existing.questions || [];
  let departmentId = existing.departmentId || null;
  if (input.departmentId !== undefined) {
    if (!input.departmentId) departmentId = null;
    else { const { departments } = await getOrgCollections(); const d = oid(input.departmentId) && await departments.findOne({ _id: oid(input.departmentId), orgId: toObjectId(orgId) }); if (!d) return fail("Department not found.", 404); departmentId = d._id; }
  }
  return {
    doc: {
      name, description: input.description !== undefined ? clean(input.description, 1000) : existing.description || "",
      ...r.rules, location, locationDetail, staffEmails, assignment, useCase, questions, departmentId,
      requiresConfirmation: input.requiresConfirmation !== undefined ? input.requiresConfirmation === true : existing.requiresConfirmation === true,
      collectPhone: input.collectPhone !== undefined ? input.collectPhone !== false : existing.collectPhone !== false,
      color: /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : existing.color || "#0b6e75",
    },
  };
}

export async function createType({ orgId, membership, actorEmail, ...input }) {
  if (!canManageCalendar(membership)) return fail("Only a calendar manager, admin or owner can create appointment types.", 403);
  await ensureEngagementIndexes();
  const v = await validateType(orgId, input);
  if (v.error) return v;
  const { calendar } = await engagementCollections();
  const doc = { orgId: toObjectId(orgId), kind: "type", ...v.doc, archived: false, createdBy: actorEmail, createdAt: nowIso(), updatedAt: nowIso() };
  const r = await calendar.insertOne(doc);
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "APPOINTMENT_TYPE", recordId: r.insertedId, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name: doc.name } });
  return { type: typeView({ ...doc, _id: r.insertedId }) };
}

export async function updateType({ orgId, membership, actorEmail, typeId, updates = {} }) {
  if (!canManageCalendar(membership)) return fail("Only a calendar manager, admin or owner can change appointment types.", 403);
  const { calendar } = await engagementCollections();
  const existing = oid(typeId) && await calendar.findOne({ _id: oid(typeId), orgId: toObjectId(orgId), kind: "type" });
  if (!existing) return fail("Appointment type not found.", 404);
  if (updates.archived !== undefined && Object.keys(updates).length === 1) {
    await calendar.updateOne({ _id: existing._id }, { $set: { archived: updates.archived === true, updatedAt: nowIso() } });
    return { type: typeView({ ...existing, archived: updates.archived === true }) };
  }
  const v = await validateType(orgId, updates, existing);
  if (v.error) return v;
  await calendar.updateOne({ _id: existing._id }, { $set: { ...v.doc, ...(updates.archived !== undefined ? { archived: updates.archived === true } : {}), updatedAt: nowIso() } });
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "APPOINTMENT_TYPE", recordId: existing._id, actorEmail, action: "UPDATED", previousState: null, newState: null, metadata: { fields: Object.keys(updates) } });
  return { type: typeView(await calendar.findOne({ _id: existing._id })) };
}

export async function getType(orgId, typeId) {
  const { calendar } = await engagementCollections();
  return oid(typeId) ? calendar.findOne({ _id: oid(typeId), orgId: toObjectId(orgId), kind: "type" }) : null;
}

// ------------------------------------------------------------- appointments

/** What any member (or the public manage page) may see. Notes and phone stay sealed out of it. */
export function publicAppointment(a) {
  if (!a) return null;
  return {
    id: String(a._id), typeId: a.typeId ? String(a.typeId) : null, typeName: a.typeName, staffEmail: a.staffEmail,
    start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString(), timeZone: a.timeZone, status: a.status,
    customer: { name: a.customer?.name || "", email: a.customer?.email || "" }, contactId: a.contactId ? String(a.contactId) : null,
    location: a.location ? { kind: a.location.kind, detail: a.location.detail || "", joinLink: a.location.joinLink || null } : null,
    source: a.source, createdAt: a.createdAt,
  };
}

function fullAppointment(a) {
  return {
    ...publicAppointment(a), customerNote: a.customerNote || "", answers: a.answers || [],
    customerPhone: openSafe(a.customer?.phoneSealed), notes: openSafe(a.notesSealed) || "", outcome: a.outcome || "",
    attachments: a.attachments || [], reminders: (a.reminders || []).map(({ id, channel, offsetMinutes, dueAt, sentAt, error }) => ({ id, channel, offsetMinutes, dueAt, sentAt, error })),
    history: a.history || [], departmentId: a.departmentId ? String(a.departmentId) : null, pageId: a.pageId ? String(a.pageId) : null,
    cancelReason: a.cancelReason || null, completedAt: a.completedAt || null, sequence: a.sequence || 0,
  };
}

/** May this member see this appointment? Own, manager, or same department (department view). */
async function canSeeAppointment(orgId, membership, appt) {
  if (canActForStaff(membership, appt.staffEmail)) return true;
  if (appt.departmentId && (membership.departmentIds || []).some((d) => String(d) === String(appt.departmentId))) return true;
  const staff = await getMemberByEmail(orgId, appt.staffEmail);
  return sharesDepartment(membership, staff);
}

/**
 * Lists appointments for the calendar views.
 * scope: "mine" (default) | "team" (managers: everyone) | "department" (departmentId; members of that department)
 */
export async function listAppointments({ orgId, membership, scope = "mine", staffEmail, departmentId, from, to, status, contactId, limit = 500 }) {
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  const q = { orgId: toObjectId(orgId), kind: "appointment" };
  const f = from ? new Date(from) : new Date(Date.now() - 31 * 86400000), t = to ? new Date(to) : new Date(Date.now() + 62 * 86400000);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return fail("from/to must be dates.");
  if (t - f > 400 * 86400000) return fail("Ask for 400 days at most.");
  q.start = { $lt: t }; q.end = { $gt: f };
  if (status) q.status = { $in: String(status).split(",").filter((s) => STATUSES.includes(s)) };
  if (contactId && oid(contactId)) q.contactId = oid(contactId);
  if (scope === "team") {
    if (!canManageCalendar(membership)) return fail("The team view is for calendar managers, admins and owners.", 403);
    if (staffEmail) q.staffEmail = normEmail(staffEmail);
  } else if (scope === "department") {
    const d = oid(departmentId);
    if (!d) return fail("Choose a department.");
    if (!canManageCalendar(membership) && !(membership.departmentIds || []).some((x) => String(x) === String(d))) return fail("You're not in that department.", 403);
    const members = (await listOrgMembers(orgId)).filter((m) => (m.departmentIds || []).some((x) => String(x) === String(d))).map((m) => normEmail(m.email));
    q.$or = [{ departmentId: d }, { staffEmail: { $in: members } }];
  } else {
    q.staffEmail = canManageCalendar(membership) && staffEmail ? normEmail(staffEmail) : normEmail(membership.email);
  }
  const rows = await calendar.find(q).sort({ start: 1 }).limit(Math.min(Number(limit) || 500, 1000)).toArray();
  return { appointments: rows.map(publicAppointment), from: f.toISOString(), to: t.toISOString() };
}

export async function getAppointment({ orgId, membership, appointmentId }) {
  const { calendar } = await engagementCollections();
  const a = oid(appointmentId) && await calendar.findOne({ _id: oid(appointmentId), orgId: toObjectId(orgId), kind: "appointment" });
  if (!a || !(await canSeeAppointment(orgId, membership, a))) return fail("Appointment not found.", 404);
  return { appointment: fullAppointment(a) };
}

async function bookedFor(orgId, staffEmail, from, to, excludeId = null) {
  const { calendar } = await engagementCollections();
  const q = { orgId: toObjectId(orgId), kind: "appointment", staffEmail: normEmail(staffEmail), status: { $in: ACTIVE }, start: { $lt: new Date(to) }, end: { $gt: new Date(from) } };
  if (excludeId) q._id = { $ne: excludeId };
  return calendar.find(q).project({ start: 1, end: 1 }).toArray();
}

/** Free slots for a type, per staff member: { slots: [{ start, staffEmail }] }. */
export async function availableSlots({ orgId, type, from, to, staffEmail = null, now = new Date(), excludeAppointmentId = null }) {
  const f = new Date(from || now), t = new Date(to || new Date(now.getTime() + 14 * 86400000));
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) return fail("Choose a valid date range.");
  if (t - f > 62 * 86400000) return fail("Ask for 62 days of slots at most.");
  const staffList = staffEmail ? type.staffEmails.filter((e) => e === normEmail(staffEmail)) : type.staffEmails;
  const out = new Map();
  for (const email of staffList) {
    const avail = await getAvailabilityDoc(orgId, email);
    if (avail?.bookable === false) continue;
    const pad = Math.max(type.bufferBeforeMinutes || 0, type.bufferAfterMinutes || 0) * 60000 + 86400000;
    const booked = await bookedFor(orgId, email, new Date(f.getTime() - pad), new Date(t.getTime() + pad), excludeAppointmentId);
    for (const s of computeSlots({ availability: avail || { timeZone: "UTC", weekly: DEFAULT_WEEKLY }, rules: type, booked, from: f, to: t, now })) {
      if (!out.has(s)) out.set(s, []);
      out.get(s).push(email);
    }
  }
  const slots = [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, staff]) => ({ start, staffEmails: staff }));
  return { slots, from: f.toISOString(), to: t.toISOString() };
}

async function upcomingLoad(orgId, emails) {
  const { calendar } = await engagementCollections();
  const rows = await calendar.aggregate([{ $match: { orgId: toObjectId(orgId), kind: "appointment", staffEmail: { $in: emails }, status: { $in: ACTIVE }, start: { $gt: new Date() } } }, { $group: { _id: "$staffEmail", n: { $sum: 1 } } }]).toArray();
  const m = new Map(rows.map((r) => [r._id, r.n]));
  return emails.map((email) => ({ email, load: m.get(email) || 0 }));
}

/** Finds the CRM contact by email or creates a LEAD in the type/page/settings department. */
export async function ensureCrmContact({ orgId, name, email, phone, company, departmentId, source }) {
  const { crmContacts, departments } = await getOrgCollections();
  const e = normEmail(email);
  if (!isEmail(e)) return null;
  const esc = e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await crmContacts.findOne({ orgId: toObjectId(orgId), email: new RegExp(`^${esc}$`, "i"), deletedAt: null });
  if (existing) return { contact: existing, created: false };
  let dept = departmentId ? await departments.findOne({ _id: toObjectId(departmentId), orgId: toObjectId(orgId) }) : null;
  if (!dept) dept = await departments.findOne({ orgId: toObjectId(orgId) }, { sort: { createdAt: 1 } });
  if (!dept) return null;
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), departmentId: dept._id, type: "LEAD", name: clean(name, 120) || e.split("@")[0], email: e, phone: phone ? clean(phone, 40) : null, company: company ? clean(company, 120) : null, taxId: null, paymentTerms: null, billingAddress: {}, shippingAddress: {}, notes: source ? `Created from ${source}` : null, createdByEmail: "appointments", createdAt: now, updatedAt: now, deletedAt: null };
  const r = await crmContacts.insertOne(doc);
  return { contact: { ...doc, _id: r.insertedId }, created: true };
}

function reminderPlan(start, settings, hasPhone) {
  const out = [];
  for (const offset of settings.reminderOffsetsMinutes || []) {
    const dueAt = new Date(new Date(start).getTime() - offset * 60000);
    if (dueAt <= new Date()) continue;
    out.push({ id: `e${offset}`, channel: "email", offsetMinutes: offset, dueAt, sentAt: null, error: null });
    if (settings.smsReminders && hasPhone) out.push({ id: `s${offset}`, channel: "sms", offsetMinutes: offset, dueAt, sentAt: null, error: null });
  }
  if (settings.postMeetingPromptMinutes > 0) out.push({ id: "post", channel: "staff_prompt", offsetMinutes: -settings.postMeetingPromptMinutes, dueAt: null, sentAt: null, error: null });
  return out;
}

async function meetingLocation({ orgId, type, staffEmail, title, start, end, customerEmail }) {
  if (type.location === "inaya_meet") {
    try {
      const membership = await getMemberByEmail(orgId, staffEmail);
      const { createRoom } = await import("../meet/rooms.js");
      const room = await createRoom({ orgId, membership, hostEmail: staffEmail, title, kind: "scheduled", scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(end).toISOString(), inviteEmails: [] });
      if (room?.joinLink) return { kind: "inaya_meet", detail: "Inaya Meet", joinLink: `${MSG.appUrl()}${room.joinLink}`, roomId: room.roomId || null };
    } catch (e) {
      console.warn("appointments: Inaya Meet room not created:", e?.message);
    }
    return { kind: "inaya_meet", detail: "Online meeting (link to follow)", joinLink: null };
  }
  if (type.location === "video_url") return { kind: "video_url", detail: "Video call", joinLink: type.locationDetail };
  if (type.location === "phone") return { kind: "phone", detail: "Phone call", joinLink: null };
  return { kind: "in_person", detail: type.locationDetail, joinLink: null };
}

function inviteFor(appt, settings, { method = "REQUEST", manageUrl } = {}) {
  return buildInvite({
    uid: appt.icsUid, start: appt.start, durationMinutes: Math.round((new Date(appt.end) - new Date(appt.start)) / 60000),
    summary: `${appt.typeName} with ${settings.businessName}`, description: `Manage: ${manageUrl}`,
    location: appt.location?.joinLink || appt.location?.detail || "", organizerEmail: appt.staffEmail, organizerName: settings.businessName,
    attendees: appt.customer?.email ? [{ email: appt.customer.email, name: appt.customer.name }] : [],
    method, sequence: appt.sequence || 0, status: method === "CANCEL" ? "CANCELLED" : "CONFIRMED", url: appt.location?.joinLink || null,
  });
}

async function notifyStaff(orgId, appt, action, settings) {
  const workspaceUrl = `${MSG.appUrl()}/business?view=appointments&appointment=${appt._id}`;
  await createNotification({
    scope: "org", orgId: toObjectId(orgId), targetEmail: appt.staffEmail, category: "business", severity: "info", type: `appointment.${action}`,
    title: `${{ booked: "New booking", rescheduled: "Booking moved", cancelled: "Booking cancelled", confirmed: "Booking confirmed" }[action] || "Booking"}: ${appt.typeName}`,
    body: `${appt.customer?.name || "Customer"}, ${new Date(appt.start).toUTCString()}`, sourceModule: "appointments", sourceId: String(appt._id),
    actionUrl: `/business?view=appointments&appointment=${appt._id}`, metadata: { status: appt.status }, dedupeKey: `appt:${action}:${appt._id}:${appt.sequence || 0}`,
  }).catch((e) => console.warn("appointments: notification failed:", e?.message));
  if (settings.notifyStaffByEmail) {
    const avail = await getAvailabilityDoc(orgId, appt.staffEmail);
    const m = MSG.staffNotificationEmail({ appt, action, staffTz: avail?.timeZone || "UTC", workspaceUrl });
    await sendEmail({ to: appt.staffEmail, ...m }).catch(() => {});
  }
}

export const manageUrlFor = (token) => `${MSG.appUrl()}/book/manage/${token}`;

/**
 * Books an appointment. Used by staff (source "staff"), the public booking page ("portal"),
 * the API ("api") and workflows ("workflow").
 */
export async function bookAppointment({ orgId, typeId, staffEmail, start, customer = {}, customerNote, answers = [], timeZone, source = "staff", pageId = null, actorEmail = null, membership = null, skipAvailabilityCheck = false, now = new Date() }) {
  await ensureEngagementIndexes();
  const type = await getType(orgId, typeId);
  if (!type || type.archived) return fail("That appointment type isn't available.", 404);
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return fail("Choose a start time.");
  const email = normEmail(customer.email);
  if (!isEmail(email)) return fail("A valid customer email is required.");
  const name = clean(customer.name, 120);
  if (!name) return fail("The customer's name is required.");
  const phone = clean(customer.phone, 40);
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return fail("Phone number should look like +92 300 1234567.");
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const qs = type.questions || [];
  const answerList = qs.map((q) => ({ id: q.id, label: q.label, value: clean((answers.find?.((a) => a.id === q.id) || {}).value, 1000) }));
  const missingQ = qs.find((q, i) => q.required && !answerList[i].value);
  if (missingQ) return fail(`Please answer: ${missingQ.label}`);

  // Staff override is allowed only for a staff booking by someone who may act for that person.
  if (source === "staff" && membership && staffEmail && !canActForStaff(membership, staffEmail)) return fail("You can only book into your own calendar.", 403);
  const end = new Date(s.getTime() + type.durationMinutes * 60000);

  let chosen = staffEmail ? normEmail(staffEmail) : null;
  if (chosen && !type.staffEmails.includes(chosen) && source !== "staff") return fail("That team member doesn't take this appointment type.", 400);
  if (!skipAvailabilityCheck) {
    const slots = await availableSlots({ orgId, type, from: new Date(s.getTime() - 1000), to: new Date(s.getTime() + 60000), staffEmail: chosen, now });
    if (slots.error) return slots;
    const hit = slots.slots.find((x) => x.start === s.toISOString());
    if (!hit) return fail("That time was just taken or isn't available any more. Please choose another time.", 409);
    if (!chosen) chosen = type.assignment === "round_robin" ? pickRoundRobin(await upcomingLoad(orgId, hit.staffEmails))?.email : hit.staffEmails[0];
  } else if (!chosen) {
    chosen = type.staffEmails[0];
  }

  const settings = await getCalendarSettings(orgId);
  const departmentId = type.departmentId || settings.defaultDepartmentId || null;
  const crm = await ensureCrmContact({ orgId, name, email, phone, departmentId, source: source === "portal" ? "the booking page" : "an appointment" });
  const token = newToken();
  const location = await meetingLocation({ orgId, type, staffEmail: chosen, title: `${type.name}: ${name}`, start: s, end, customerEmail: email });
  const status = type.requiresConfirmation && source === "portal" ? "PENDING" : "CONFIRMED";
  const doc = {
    orgId: toObjectId(orgId), kind: "appointment", typeId: type._id, typeName: type.name, useCase: type.useCase, staffEmail: chosen,
    start: s, end, timeZone: tz, status, customer: { name, email, phoneSealed: phone ? seal(phone) : null },
    contactId: crm?.contact?._id || null, departmentId: departmentId ? toObjectId(departmentId) : null,
    customerNote: clean(customerNote, 2000), answers: answerList, location, attachments: [], notesSealed: null, outcome: "",
    reminders: reminderPlan(s, settings, !!phone), manageTokenHash: hashToken(token), manageTokenSealed: seal(token), icsUid: `${randomUUID()}@inayanetwork.com`, sequence: 0,
    source, pageId: pageId ? oid(pageId) : null, history: [{ at: nowIso(), by: actorEmail || email, action: "BOOKED", to: status }],
    createdByEmail: actorEmail || null, createdAt: nowIso(), updatedAt: nowIso(),
  };
  const post = doc.reminders.find((r) => r.id === "post");
  if (post) post.dueAt = new Date(end.getTime() + settings.postMeetingPromptMinutes * 60000);

  const { calendar } = await engagementCollections();
  const ins = await calendar.insertOne(doc);
  doc._id = ins.insertedId;
  // Double-booking guard: two requests that both passed the slot check race here; the lower _id wins.
  const clash = await calendar.findOne({ orgId: toObjectId(orgId), kind: "appointment", staffEmail: chosen, status: { $in: ACTIVE }, _id: { $lt: doc._id }, start: { $lt: end }, end: { $gt: s } });
  if (clash && !skipAvailabilityCheck) {
    await calendar.deleteOne({ _id: doc._id });
    return fail("That time was just taken. Please choose another time.", 409);
  }

  const manageUrl = manageUrlFor(token);
  const conf = MSG.confirmationEmail({ appt: doc, businessName: settings.businessName, manageUrl, pending: status === "PENDING" });
  const delivery = await sendEmail({ to: email, ...conf, replyTo: settings.replyToEmail || chosen, attachments: status === "CONFIRMED" ? [{ filename: "invite.ics", content: Buffer.from(inviteFor(doc, settings, { manageUrl })).toString("base64"), contentType: "text/calendar; method=REQUEST" }] : undefined }).catch((e) => ({ sent: false, reason: e?.message }));
  await notifyStaff(orgId, doc, "booked", settings);
  if (crm?.contact) {
    await logActivity({ orgId, contact: crm.contact, type: "NOTE", subject: `Booked: ${type.name}`, body: `${type.name} on ${s.toISOString()} with ${chosen} (${source}).`, at: nowIso(), actorEmail: actorEmail || "appointments", extra: { appointmentId: String(doc._id) } }).catch(() => {});
  }
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "APPOINTMENT", recordId: doc._id, actorEmail: actorEmail || email, action: "BOOKED", previousState: null, newState: status, metadata: { typeId: String(type._id), staffEmail: chosen, source } }).catch(() => {});
  emitEvent(orgId, "appointment.booked", doc, { contactId: doc.contactId ? String(doc.contactId) : null, contactCreated: !!crm?.created });
  return { appointment: fullAppointment(doc), manageToken: token, manageUrl, emailSent: delivery?.sent !== false };
}

async function loadForAction({ orgId, membership, appointmentId }) {
  const { calendar } = await engagementCollections();
  const a = oid(appointmentId) && await calendar.findOne({ _id: oid(appointmentId), orgId: toObjectId(orgId), kind: "appointment" });
  if (!a) return { error: fail("Appointment not found.", 404) };
  if (membership && !canActForStaff(membership, a.staffEmail)) return { error: fail("Only the assigned team member or a calendar manager can change this appointment.", 403) };
  return { a };
}

/** Status changes: CONFIRMED, COMPLETED, NO_SHOW, CANCELLED. Completing logs the meeting on the CRM record. */
export async function transitionAppointment({ orgId, membership, actorEmail, appointmentId, toStatus, reason, outcome, byCustomer = false, appt: preloaded = null }) {
  const loaded = preloaded ? { a: preloaded } : await loadForAction({ orgId, membership, appointmentId });
  if (loaded.error) return loaded.error;
  const a = loaded.a;
  if (!STATUSES.includes(toStatus)) return fail("Unknown status.");
  if (!(TRANSITIONS[a.status] || []).includes(toStatus)) return fail(`An appointment that is ${a.status.toLowerCase().replace("_", "-")} can't become ${toStatus.toLowerCase().replace("_", "-")}.`, 409);
  if (["COMPLETED", "NO_SHOW"].includes(toStatus) && new Date(a.start) > new Date()) return fail("You can mark it after it has started.", 409);
  const settings = await getCalendarSettings(orgId);
  const set = { status: toStatus, updatedAt: nowIso() };
  if (toStatus === "CANCELLED") { set.cancelReason = clean(reason, 500) || null; set.cancelledBy = byCustomer ? "customer" : actorEmail; set.sequence = (a.sequence || 0) + 1; }
  if (toStatus === "COMPLETED") { set.completedAt = nowIso(); if (outcome !== undefined) set.outcome = clean(outcome, 4000); }
  const { calendar } = await engagementCollections();
  const r = await calendar.updateOne({ _id: a._id, status: a.status }, { $set: set, $push: { history: { at: nowIso(), by: byCustomer ? a.customer?.email : actorEmail, action: toStatus, from: a.status, to: toStatus, ...(set.cancelReason ? { reason: set.cancelReason } : {}) } } });
  if (!r.modifiedCount) return fail("Someone else changed this appointment just now. Refresh and try again.", 409);
  const next = { ...a, ...set };

  if (toStatus === "CANCELLED") {
    const page = a.pageId ? await calendar.findOne({ _id: a.pageId, kind: "page" }) : null;
    const m = MSG.cancellationEmail({ appt: next, businessName: settings.businessName, rebookUrl: page?.active ? `${MSG.appUrl()}/book/${page.slug}` : null, reason: set.cancelReason });
    await sendEmail({ to: a.customer.email, ...m, replyTo: settings.replyToEmail || a.staffEmail, attachments: [{ filename: "cancel.ics", content: Buffer.from(inviteFor(next, settings, { method: "CANCEL", manageUrl: "" })).toString("base64"), contentType: "text/calendar; method=CANCEL" }] }).catch(() => {});
    await notifyStaff(orgId, next, "cancelled", settings);
  }
  if (toStatus === "CONFIRMED" && a.status === "PENDING") {
    await notifyStaff(orgId, next, "confirmed", settings);
    if (!byCustomer) {
      // The raw manage token is never stored, so confirming issues a fresh link (the old one stops working).
      const token = newToken();
      await calendar.updateOne({ _id: a._id }, { $set: { manageTokenHash: hashToken(token), manageTokenSealed: seal(token) } });
      const manageUrl = manageUrlFor(token);
      const conf = MSG.confirmationEmail({ appt: next, businessName: settings.businessName, manageUrl, pending: false });
      await sendEmail({ to: a.customer.email, ...conf, replyTo: settings.replyToEmail || a.staffEmail, attachments: [{ filename: "invite.ics", content: Buffer.from(inviteFor(next, settings, { manageUrl })).toString("base64"), contentType: "text/calendar; method=REQUEST" }] }).catch(() => {});
    }
  }
  if (toStatus === "COMPLETED" && a.contactId) {
    const { crmContacts } = await getOrgCollections();
    const contact = await crmContacts.findOne({ _id: a.contactId, orgId: toObjectId(orgId) });
    if (contact) await logActivity({ orgId, contact, type: "MEETING", subject: a.typeName, body: set.outcome || openSafe(a.notesSealed) || "Meeting held.", at: new Date(a.start).toISOString(), durationMinutes: Math.round((new Date(a.end) - new Date(a.start)) / 60000), actorEmail: actorEmail || a.staffEmail, extra: { appointmentId: String(a._id) } }).catch(() => {});
  }
  if (toStatus === "COMPLETED" && settings.followUpSequenceId) {
    // Integrated workflow step 8: the follow-up campaign after the meeting.
    const { enrollMany } = await import("./sequences.js");
    await enrollMany({ orgId, sequenceId: settings.followUpSequenceId, people: [{ email: a.customer?.email, name: a.customer?.name, contactId: a.contactId }], source: `after ${a.typeName}` }).catch(() => {});
  }
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "APPOINTMENT", recordId: a._id, actorEmail: byCustomer ? a.customer?.email : actorEmail, action: toStatus, previousState: a.status, newState: toStatus, metadata: { byCustomer } }).catch(() => {});
  emitEvent(orgId, `appointment.${toStatus.toLowerCase()}`, next, { contactId: a.contactId ? String(a.contactId) : null });
  return { appointment: fullAppointment(next) };
}

/** Moves an appointment to a new start (same type and duration). Re-checks availability. */
export async function rescheduleAppointment({ orgId, membership, actorEmail, appointmentId, start, staffEmail, byCustomer = false, appt: preloaded = null, now = new Date() }) {
  const loaded = preloaded ? { a: preloaded } : await loadForAction({ orgId, membership, appointmentId });
  if (loaded.error) return loaded.error;
  const a = loaded.a;
  if (!ACTIVE.includes(a.status)) return fail("Only upcoming appointments can be moved.", 409);
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return fail("Choose a new time.");
  const type = await getType(orgId, a.typeId);
  if (!type) return fail("This appointment's type no longer exists; book a new one instead.", 409);
  const targetStaff = staffEmail && !byCustomer ? normEmail(staffEmail) : a.staffEmail;
  if (!byCustomer && membership && !canActForStaff(membership, targetStaff)) return fail("You can't move this into someone else's calendar.", 403);
  const slots = await availableSlots({ orgId, type, from: new Date(s.getTime() - 1000), to: new Date(s.getTime() + 60000), staffEmail: targetStaff, now, excludeAppointmentId: a._id });
  if (slots.error) return slots;
  if (!slots.slots.some((x) => x.start === s.toISOString())) return fail("That time isn't available. Please choose another.", 409);
  const end = new Date(s.getTime() + (new Date(a.end) - new Date(a.start)));
  const settings = await getCalendarSettings(orgId);
  const hasPhone = !!a.customer?.phoneSealed;
  const reminders = reminderPlan(s, settings, hasPhone);
  const post = reminders.find((r) => r.id === "post");
  if (post) post.dueAt = new Date(end.getTime() + settings.postMeetingPromptMinutes * 60000);
  const set = { start: s, end, staffEmail: targetStaff, reminders, sequence: (a.sequence || 0) + 1, updatedAt: nowIso(), status: "CONFIRMED" };
  if (a.status === "PENDING" && byCustomer) set.status = "PENDING";
  const { calendar } = await engagementCollections();
  const r = await calendar.updateOne({ _id: a._id, sequence: a.sequence || 0 }, { $set: set, $push: { history: { at: nowIso(), by: byCustomer ? a.customer?.email : actorEmail, action: "RESCHEDULED", from: new Date(a.start).toISOString(), to: s.toISOString() } } });
  if (!r.modifiedCount) return fail("Someone else changed this appointment just now. Refresh and try again.", 409);
  const clash = await calendar.findOne({ orgId: toObjectId(orgId), kind: "appointment", staffEmail: targetStaff, status: { $in: ACTIVE }, _id: { $ne: a._id }, start: { $lt: end }, end: { $gt: s } });
  if (clash) {
    await calendar.updateOne({ _id: a._id }, { $set: { start: a.start, end: a.end, staffEmail: a.staffEmail, reminders: a.reminders, sequence: set.sequence + 1, status: a.status } });
    return fail("That time was just taken. Please choose another.", 409);
  }
  const next = { ...a, ...set };
  const token = newToken();
  await calendar.updateOne({ _id: a._id }, { $set: { manageTokenHash: hashToken(token), manageTokenSealed: seal(token) } });
  const manageUrl = manageUrlFor(token);
  const m = MSG.rescheduleEmail({ appt: next, businessName: settings.businessName, manageUrl, previousStart: a.start });
  await sendEmail({ to: a.customer.email, ...m, replyTo: settings.replyToEmail || targetStaff, attachments: [{ filename: "invite.ics", content: Buffer.from(inviteFor(next, settings, { manageUrl })).toString("base64"), contentType: "text/calendar; method=REQUEST" }] }).catch(() => {});
  await notifyStaff(orgId, next, "rescheduled", settings);
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "APPOINTMENT", recordId: a._id, actorEmail: byCustomer ? a.customer?.email : actorEmail, action: "RESCHEDULED", previousState: new Date(a.start).toISOString(), newState: s.toISOString(), metadata: { byCustomer } }).catch(() => {});
  emitEvent(orgId, "appointment.rescheduled", next);
  return { appointment: fullAppointment(next), manageUrl: byCustomer ? manageUrl : undefined, manageToken: byCustomer ? token : undefined };
}

/** Internal notes (encrypted), outcome, attachments (org document ids), CRM contact link. */
export async function updateAppointmentDetails({ orgId, membership, actorEmail, appointmentId, notes, outcome, addAttachment, removeAttachmentId, contactId }) {
  const loaded = await loadForAction({ orgId, membership, appointmentId });
  if (loaded.error) return loaded.error;
  const a = loaded.a;
  const set = { updatedAt: nowIso() }; const ops = {};
  if (notes !== undefined) set.notesSealed = seal(clean(notes, 20000)) ;
  if (outcome !== undefined) set.outcome = clean(outcome, 4000);
  if (contactId !== undefined) {
    if (contactId === null) set.contactId = null;
    else { const { crmContacts } = await getOrgCollections(); const c = oid(contactId) && await crmContacts.findOne({ _id: oid(contactId), orgId: toObjectId(orgId), deletedAt: null }); if (!c) return fail("CRM contact not found.", 404); set.contactId = c._id; }
  }
  if (addAttachment) {
    const { orgDocuments } = await getOrgCollections();
    const d = oid(addAttachment.documentId) && await orgDocuments.findOne({ _id: oid(addAttachment.documentId), orgId: toObjectId(orgId) });
    if (!d) return fail("Document not found in this company's files.", 404);
    if ((a.attachments || []).length >= 20) return fail("20 attachments at most.");
    ops.$push = { attachments: { id: randomUUID().slice(0, 12), documentId: String(d._id), label: clean(addAttachment.label, 120) || d.fileName || d.name || "Document", addedBy: actorEmail, addedAt: nowIso() } };
  }
  if (removeAttachmentId) ops.$pull = { attachments: { id: String(removeAttachmentId) } };
  const { calendar } = await engagementCollections();
  if (ops.$push && ops.$pull) { await calendar.updateOne({ _id: a._id }, { $pull: ops.$pull }); delete ops.$pull; }
  await calendar.updateOne({ _id: a._id }, { $set: set, ...ops });
  return { appointment: fullAppointment(await calendar.findOne({ _id: a._id })) };
}

// ------------------------------------------------------- customer self-serve

export async function findByManageToken(token) {
  if (!token || String(token).length < 20) return null;
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  return calendar.findOne({ kind: "appointment", manageTokenHash: hashToken(token) });
}

export async function customerView(token) {
  const a = await findByManageToken(token);
  if (!a) return fail("This link isn't valid any more. Use the newest email we sent you.", 404);
  const settings = await getCalendarSettings(a.orgId);
  return { appointment: publicAppointment(a), businessName: settings.businessName, canChange: ACTIVE.includes(a.status) && new Date(a.start) > new Date(), orgId: String(a.orgId) };
}

export async function customerAction({ token, action, start, reason }) {
  const a = await findByManageToken(token);
  if (!a) return fail("This link isn't valid any more. Use the newest email we sent you.", 404);
  if (new Date(a.start) <= new Date()) return fail("This appointment has already started.", 409);
  const orgId = String(a.orgId);
  if (action === "cancel") {
    const r = await transitionAppointment({ orgId, appt: a, toStatus: "CANCELLED", reason, byCustomer: true });
    return r.error ? r : { appointment: publicAppointment({ ...a, status: "CANCELLED" }) };
  }
  if (action === "confirm") {
    if (a.status === "CONFIRMED") return { appointment: publicAppointment(a), alreadyConfirmed: true };
    return fail("Your booking is waiting for the team to confirm it.", 409);
  }
  if (action === "reschedule") {
    const r = await rescheduleAppointment({ orgId, appt: a, start, byCustomer: true });
    if (r.error) return r;
    return { appointment: publicAppointment({ ...a, start: new Date(r.appointment.start), end: new Date(r.appointment.end), status: r.appointment.status }), manageToken: r.manageToken };
  }
  return fail("Unknown action.");
}

export async function customerSlots({ token, from, to }) {
  const a = await findByManageToken(token);
  if (!a) return fail("This link isn't valid any more.", 404);
  const type = await getType(a.orgId, a.typeId);
  if (!type) return fail("This appointment type is no longer offered.", 409);
  const r = await availableSlots({ orgId: a.orgId, type, from, to, staffEmail: a.staffEmail, excludeAppointmentId: a._id });
  if (r.error) return r;
  return { slots: r.slots.map((s) => s.start), timeZone: a.timeZone };
}
