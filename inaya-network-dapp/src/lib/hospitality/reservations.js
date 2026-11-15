// src/lib/hospitality/reservations.js
//
// Reservations, table assignment, conflict prevention, waitlist, guest (CRM) linking, public booking (SOW 8, 9).
//
// Conflict prevention (SOW 8.5) does not depend on transactions:
//   * every reservation sits on the 15-minute grid;
//   * a table is held by one `h_lock` document per table per 15-minute slot, under a unique index, so two
//     simultaneous bookings of the same table can never both succeed;
//   * covers per location per slot are counted in `h_cap` documents with a conditional atomic $inc, so the
//     configured capacity can't be exceeded by concurrent requests either.

import { randomBytes, createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { sendEmail } from "../email.js";
import { zonedToUtc, zonedDateKey, weekdayOfKey, minutesOf, DAY_KEYS, addDaysKey, zonedParts } from "../engagement/time.js";
import { ensureCrmContact } from "../engagement/appointments.js";
import { recordConsent } from "../engagement/suppression.js";
import { hcol, KINDS, CAN, fail, clean, nowIso, oid, sid, intIn, isEmail, normEmail, normPhone, logH, emitH, notifyRoles, nextNumber, requireLocation, allowedLocations, ensureHospitalityIndexes } from "./store.js";
import { loadSeating, turnMinutes, publicTable } from "./locations.js";
import { reservationEmail, waitlistInviteEmail } from "./messages.js";

export const STATUSES = ["REQUESTED", "PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW", "DECLINED"];
export const ACTIVE = ["REQUESTED", "PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED", "SEATED"];
export const TRANSITIONS = {
  REQUESTED: ["PENDING_CONFIRMATION", "CONFIRMED", "DECLINED", "CANCELLED"],
  PENDING_CONFIRMATION: ["CONFIRMED", "DECLINED", "CANCELLED"],
  CONFIRMED: ["ARRIVED", "SEATED", "CANCELLED", "NO_SHOW"],
  ARRIVED: ["SEATED", "CANCELLED"],
  SEATED: ["COMPLETED"],
  COMPLETED: [], CANCELLED: [], NO_SHOW: [], DECLINED: [],
};
export const SOURCES = ["staff", "phone", "walk_in", "web", "integration"];
export const TYPES = ["table", "private_event", "catering", "tasting", "consultation"];
export const WAITLIST_STATUSES = ["WAITING", "INVITED", "SEATED", "EXPIRED", "CANCELLED"];
const SLOT_MS = 15 * 60000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");

// ---------- pure helpers (unit-tested) ----------
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/** 15-minute bucket numbers covered by [start, end). */
export function buckets(start, end) {
  const a = Math.floor(new Date(start).getTime() / SLOT_MS), b = Math.ceil(new Date(end).getTime() / SLOT_MS);
  const out = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

/** Is `table` blocked (temporary closure) or inactive during [start, end)? */
export function tableUnavailable(table, start, end, closedAreaIds = new Set()) {
  if (table.active === false || closedAreaIds.has(String(table.areaId))) return true;
  return (table.blocks || []).some((b) => new Date(b.from) < new Date(end) && new Date(start) < new Date(b.to));
}

/**
 * Chooses tables for a party from the free ones: the smallest single table that fits, otherwise the smallest
 * pair of mutually combinable tables. Deliberately simple (SOW 8.4: no optimisation engine).
 */
export function pickTables(freeTables, partySize, preferredAreaId = null) {
  const pref = (t) => (preferredAreaId && String(t.areaId) === String(preferredAreaId) ? 0 : 1);
  const single = freeTables.filter((t) => t.minParty <= partySize && partySize <= t.maxParty).sort((a, b) => pref(a) - pref(b) || a.maxParty - b.maxParty || String(a.label).localeCompare(String(b.label)));
  if (single.length) return [single[0]];
  let best = null;
  for (const a of freeTables) for (const b of freeTables) {
    if (String(a._id) >= String(b._id)) continue;
    if (!(a.combinableWith || []).map(String).includes(String(b._id))) continue;
    const cap = a.maxParty + b.maxParty;
    if (cap < partySize) continue;
    const score = [pref(a) + pref(b), cap];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { pair: [a, b], score };
  }
  return best ? best.pair : [];
}

/** Can these tables seat the party? One table: within its range. Several: enough seats between them. */
export function partyFits(tables, partySize) {
  if (!tables.length) return false;
  if (tables.length === 1) return tables[0].minParty <= partySize && partySize <= tables[0].maxParty;
  return tables.reduce((n, t) => n + t.maxParty, 0) >= partySize;
}

/** May these tables be used together? One table always; several only when every pair is marked combinable. */
export function tablesCombinable(tables) {
  for (const a of tables) for (const b of tables) {
    if (String(a._id) === String(b._id)) continue;
    if (!(a.combinableWith || []).map(String).includes(String(b._id))) return false;
  }
  return true;
}

/**
 * Candidate start times for a local date: inside a service period, on the slot grid, no later than the last
 * seating, respecting lead time, booking horizon and closures. Handles DST through zonedToUtc.
 */
export function candidateSlots(location, dateKey, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "")) return [];
  if ((location.closures || []).some((c) => c.date === dateKey)) return [];
  const policy = location.policy || {};
  const today = zonedDateKey(now, location.timeZone);
  if (dateKey < today || dateKey > addDaysKey(today, policy.horizonDays ?? 60)) return [];
  const periods = location.hours?.[DAY_KEYS[weekdayOfKey(dateKey)]] || [];
  const step = policy.slotMinutes || 15, lastSeating = policy.lastSeatingMinutes ?? 60;
  const earliest = now.getTime() + (policy.leadMinutes ?? 0) * 60000;
  const out = [];
  for (const p of periods) {
    const from = minutesOf(p.from), to = minutesOf(p.to);
    for (let m = from; m + Math.min(lastSeating, to - from) <= to; m += step) {
      const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const start = zonedToUtc(dateKey, time, location.timeZone);
      // A wall-clock time skipped by a DST change maps to a later instant; drop it rather than offer a wrong time.
      const z = zonedParts(start, location.timeZone);
      if (z.hour * 60 + z.minute !== m) continue;
      if (start.getTime() < earliest) continue;
      out.push({ time, start, period: p.label || null });
    }
  }
  return out;
}

/** Fields each role may see (SOW 8.7, 20.1): service staff don't get contact details or private notes. */
export function reservationView(r, membership, { tables = null } = {}) {
  const notes = CAN.guestNotes(membership);
  return {
    id: sid(r._id), ref: r.ref, type: r.type, locationId: sid(r.locationId), status: r.status, source: r.source, partySize: r.partySize,
    date: r.date, time: r.time, start: r.start, end: r.end, durationMinutes: r.durationMinutes, timeZone: r.timeZone,
    tableIds: (r.tableIds || []).map(String), tableLabels: tables ? (r.tableIds || []).map((t) => tables.get(String(t))?.label).filter(Boolean) : undefined, areaId: sid(r.areaId),
    guest: { name: r.guest?.name || "Guest", ...(notes ? { email: r.guest?.email || null, phone: r.guest?.phone || null } : {}) },
    contactId: sid(r.contactId), occasion: r.occasion || null, guestNote: r.guestNote || null, preferences: r.preferences || null, eventDetails: r.eventDetails || null,
    ...(notes ? { internalNote: r.internalNote || null, matchCandidates: (r.matchCandidates || []).map(String), cancelReason: r.cancelReason || null, marketingConsent: !!r.marketingConsent } : {}),
    servedByEmail: r.servedByEmail || null, confirmation: r.confirmation || null, reminder: r.reminder ? { dueAt: r.reminder.dueAt, sentAt: r.reminder.sentAt || null } : null,
    feedback: r.feedback || null, outcome: r.outcome || null, createdByEmail: r.createdByEmail || null, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

// ---------- locks and capacity ----------
const lockKey = (tableId, bucket) => `t:${tableId}:${bucket}`;
const capKey = (locationId, bucket) => `c:${locationId}:${bucket}`;

/** Makes `reservationId` the holder of exactly `tableIds` over [start, end). Returns { ok } or { conflict: true }. */
async function setLocks(orgId, reservationId, tableIds, start, end) {
  const c = await hcol();
  const org = toObjectId(orgId), rid = toObjectId(reservationId);
  const want = new Set();
  for (const t of tableIds) for (const b of buckets(start, end)) want.add(lockKey(t, b));
  const mine = await c.find({ orgId: org, kind: KINDS.lock, reservationId: rid }).project({ lockKey: 1 }).toArray();
  const have = new Set(mine.map((l) => l.lockKey));
  const add = [...want].filter((k) => !have.has(k));
  if (add.length) {
    try {
      await c.insertMany(add.map((k) => ({ orgId: org, kind: KINDS.lock, lockKey: k, reservationId: rid, tableId: toObjectId(k.split(":")[1]), start: new Date(Number(k.split(":")[2]) * SLOT_MS), createdAt: nowIso() })), { ordered: false });
    } catch (e) {
      if (e?.code !== 11000 && !e?.writeErrors?.length) throw e;
      await c.deleteMany({ orgId: org, kind: KINDS.lock, reservationId: rid, lockKey: { $in: add } });
      return { conflict: true };
    }
  }
  const drop = [...have].filter((k) => !want.has(k));
  if (drop.length) await c.deleteMany({ orgId: org, kind: KINDS.lock, reservationId: rid, lockKey: { $in: drop } });
  return { ok: true };
}
const releaseLocks = async (orgId, reservationId) => (await hcol()).deleteMany({ orgId: toObjectId(orgId), kind: KINDS.lock, reservationId: toObjectId(reservationId) });

/** Adds `party` covers to every slot of [start, end); refuses when `max` would be exceeded. Returns { ok } or { full: true }. */
async function addCovers(orgId, locationId, start, end, party, max) {
  const c = await hcol();
  const org = toObjectId(orgId);
  if (max !== null && max !== undefined && party > max) return { full: true };
  const done = [];
  for (const b of buckets(start, end)) {
    const key = capKey(locationId, b);
    const filter = { orgId: org, kind: KINDS.cap, capKey: key, ...(max !== null && max !== undefined ? { covers: { $lte: max - party } } : {}) };
    try {
      await c.updateOne(filter, { $inc: { covers: party }, $setOnInsert: { orgId: org, kind: KINDS.cap, capKey: key, locationId: toObjectId(locationId), start: new Date(b * SLOT_MS) } }, { upsert: true });
      done.push(key);
    } catch (e) {
      if (e?.code !== 11000) throw e;
      // Duplicate key means the counter already exists: either another request created it a moment ago (retry
      // as a plain conditional update), or it's too full for the filter (the update matches nothing).
      const retry = await c.updateOne(filter, { $inc: { covers: party } });
      if (retry.matchedCount) { done.push(key); continue; }
      if (done.length) await c.updateMany({ orgId: org, kind: KINDS.cap, capKey: { $in: done } }, { $inc: { covers: -party } });
      return { full: true };
    }
  }
  return { ok: true };
}
async function removeCovers(orgId, locationId, start, end, party) {
  const c = await hcol();
  await c.updateMany({ orgId: toObjectId(orgId), kind: KINDS.cap, capKey: { $in: buckets(start, end).map((b) => capKey(locationId, b)) } }, { $inc: { covers: -party } });
}

/** Tables with no lock in [start, end), not blocked, in an open area. `ignoreReservationId` treats that booking's own locks as free. */
async function freeTables(orgId, location, start, end, { ignoreReservationId = null, seating = null } = {}) {
  const c = await hcol();
  const { areas, tables } = seating || (await loadSeating(orgId, location._id));
  const closed = new Set(areas.filter((a) => a.closed).map((a) => String(a._id)));
  const keys = [];
  for (const t of tables) for (const b of buckets(start, end)) keys.push(lockKey(t._id, b));
  const locks = keys.length ? await c.find({ orgId: toObjectId(orgId), kind: KINDS.lock, lockKey: { $in: keys } }).project({ tableId: 1, reservationId: 1 }).toArray() : [];
  const taken = new Set(locks.filter((l) => String(l.reservationId) !== String(ignoreReservationId || "")).map((l) => String(l.tableId)));
  return { areas, tables, free: tables.filter((t) => !taken.has(String(t._id)) && !tableUnavailable(t, start, end, closed)) };
}

async function coversAt(orgId, locationId, start, end) {
  const c = await hcol();
  const rows = await c.find({ orgId: toObjectId(orgId), kind: KINDS.cap, capKey: { $in: buckets(start, end).map((b) => capKey(locationId, b)) } }).project({ covers: 1 }).toArray();
  return rows.reduce((m, r) => Math.max(m, r.covers || 0), 0);
}

// ---------- availability ----------
/** Slots for a date and party size, each marked available or not with a plain reason. Rechecked at booking time. */
export async function availabilityFor(orgId, location, dateKey, partySize, { now = new Date() } = {}) {
  const dur = turnMinutes(location.policy, partySize);
  const seating = await loadSeating(orgId, location._id);
  const max = location.policy?.maxCoversPerSlot ?? null;
  const out = [];
  for (const s of candidateSlots(location, dateKey, now)) {
    const end = new Date(s.start.getTime() + dur * 60000);
    let available = true, reason = null;
    if (max !== null && (await coversAt(orgId, location._id, s.start, end)) + partySize > max) { available = false; reason = "Fully booked"; }
    if (available && seating.tables.length) {
      const { free } = await freeTables(orgId, location, s.start, end, { seating });
      if (!pickTables(free, partySize).length) { available = false; reason = "No table for this party size"; }
    }
    out.push({ time: s.time, start: s.start.toISOString(), period: s.period, available, reason });
  }
  return { date: dateKey, partySize, durationMinutes: dur, timeZone: location.timeZone, slots: out };
}

// ---------- guests (CRM) ----------
/**
 * Links a guest to the CRM under the matching policy (SOW 9.2): an exact email match links; a phone-only match
 * is never linked automatically, it's kept as a candidate for a manager to review; a new guest with an email
 * becomes a new CRM contact. Guests with neither are not added to the CRM.
 */
async function linkGuest(orgId, guest) {
  const { crmContacts } = await getOrgCollections();
  const org = toObjectId(orgId);
  if (isEmail(guest.email)) {
    const r = await ensureCrmContact({ orgId, name: guest.name, email: guest.email, phone: guest.phone, source: "hospitality" });
    if (r?.contact) return { contactId: r.contact._id, created: r.created, candidates: [] };
  }
  const phone = normPhone(guest.phone);
  if (phone) {
    const tail = phone.replace(/\D/g, "").slice(-9);
    const rows = await crmContacts.find({ orgId: org, deletedAt: null, phone: { $type: "string", $ne: "" } }).project({ phone: 1 }).limit(5000).toArray();
    const candidates = rows.filter((c) => String(c.phone).replace(/\D/g, "").endsWith(tail)).slice(0, 5).map((c) => c._id);
    return { contactId: null, created: false, candidates };
  }
  return { contactId: null, created: false, candidates: [] };
}

async function recordVisit(orgId, r, actorEmail) {
  if (!r.contactId) return;
  try {
    const { crmContacts } = await getOrgCollections();
    await crmContacts.updateOne({ _id: r.contactId, orgId: toObjectId(orgId) }, { $inc: { "hospitality.visits": 1 }, $set: { "hospitality.lastVisitAt": new Date(r.start).toISOString(), "hospitality.lastLocationId": r.locationId, updatedAt: nowIso() } });
    const contact = await crmContacts.findOne({ _id: r.contactId, orgId: toObjectId(orgId) });
    const { logActivity } = await import("../crm-activity.js");
    if (contact) await logActivity({ orgId, contact, type: "MEETING", subject: `Visit ${r.ref}: party of ${r.partySize}`, body: r.outcome || "", at: new Date(r.start).toISOString(), actorEmail, extra: { hospitalityReservationId: String(r._id) } });
  } catch (e) { console.error("hospitality visit link failed:", e.message); }
}

async function businessName(orgId) {
  const { orgs } = await getOrgCollections();
  return (await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1 } }))?.name || "Our restaurant";
}

/** Sends a guest email and records what actually happened: "accepted by the mail provider" is not "delivered" (SOW 14.4). */
async function sendGuest(orgId, r, location, kind, { token = null, reason = null } = {}) {
  if (!isEmail(r.guest?.email)) return { skipped: "no_email" };
  const c = await hcol();
  try {
    const business = location.senderName || (await businessName(orgId));
    const m = reservationEmail({ kind, r, location, business, token, reason });
    await sendEmail({ to: r.guest.email, ...m, ...(location.email ? { replyTo: location.email } : {}) });
    await c.updateOne({ _id: r._id }, { $set: { [`confirmation.${kind}`]: { status: "accepted_by_provider", at: nowIso() } } });
    return { accepted: true };
  } catch (e) {
    await c.updateOne({ _id: r._id }, { $set: { [`confirmation.${kind}`]: { status: "failed", at: nowIso(), error: String(e?.message || e).slice(0, 200) } } });
    return { failed: true };
  }
}

// ---------- create ----------
function guestFrom(body) {
  const name = clean(body.name ?? body.guest?.name, 120);
  const email = normEmail(body.email ?? body.guest?.email);
  const phone = clean(body.phone ?? body.guest?.phone, 40);
  if (!name) return { error: "The guest's name is required." };
  if (email && !isEmail(email)) return { error: "That email address doesn't look right." };
  return { guest: { name, email: email || null, phone: phone || null } };
}

/**
 * Core booking. `source` decides the first status: walk-ins are seated now, staff/phone bookings are confirmed,
 * web bookings follow the location's confirmation policy. Capacity and tables are claimed atomically before the
 * reservation becomes visible as active; on any failure everything claimed is released.
 */
async function book({ orgId, location, actorEmail, body, source, now = new Date() }) {
  await ensureHospitalityIndexes();
  const c = await hcol();
  const org = toObjectId(orgId);
  const g = guestFrom(body);
  if (g.error) return fail(g.error);
  const partySize = intIn(body.partySize, 1, 500);
  if (partySize === null) return fail("Party size must be a whole number of guests.");
  const type = TYPES.includes(body.type) ? body.type : "table";
  const idem = body.idempotencyKey ? clean(body.idempotencyKey, 80) : null;
  if (idem) {
    const prior = await c.findOne({ orgId: org, kind: KINDS.reservation, idempotencyKey: idem });
    if (prior) return { reservation: prior, repeated: true };
  }

  let start, date, time;
  if (source === "walk_in") {
    start = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS);
    date = zonedDateKey(start, location.timeZone);
    const z = zonedParts(start, location.timeZone);
    time = `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
  } else {
    date = clean(body.date, 10); time = clean(body.time, 5);
    const mins = minutesOf(time);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || mins === null || mins % 15) return fail("Choose a date and a time on the quarter hour.");
    start = zonedToUtc(date, time, location.timeZone);
    const z = zonedParts(start, location.timeZone);
    if (z.hour * 60 + z.minute !== mins) return fail("That time doesn't exist on this date (the clocks change). Choose another time.");
    if (source === "web") {
      if (!candidateSlots(location, date, now).some((s) => s.time === time)) return fail("That time isn't open for booking. Choose another.", 409);
      if (partySize > (location.policy?.maxPartyOnline ?? 8)) return fail(`For parties larger than ${location.policy?.maxPartyOnline ?? 8}, please contact us directly.`, 409);
    } else if (start.getTime() < now.getTime() - 12 * 3600000) return fail("That time is in the past.");
  }
  const durationMinutes = body.durationMinutes ? intIn(body.durationMinutes, 15, 720) : turnMinutes(location.policy, partySize);
  if (durationMinutes === null || durationMinutes % 15) return fail("Length must be in quarter hours.");
  const end = new Date(start.getTime() + durationMinutes * 60000);

  const rid = new (await import("mongodb")).ObjectId();
  const max = location.policy?.maxCoversPerSlot ?? null;
  // Staff may knowingly overbook covers (override: true); the public page never can.
  const cap = await addCovers(orgId, location._id, start, end, partySize, source !== "web" && body.override === true ? null : max);
  if (cap.full) return { ...fail("That time is fully booked.", 409), alternatives: source === "web" || body.wantAlternatives ? await nearestAlternatives(orgId, location, date, partySize, time, now) : undefined };

  const { areas, tables, free } = await freeTables(orgId, location, start, end);
  let chosen = [];
  const explicit = Array.isArray(body.tableIds) ? [...new Set(body.tableIds.map(String))] : null;
  if (explicit?.length) {
    chosen = explicit.map((id) => tables.find((t) => String(t._id) === id));
    if (chosen.some((t) => !t)) { await removeCovers(orgId, location._id, start, end, partySize); return fail("One of those tables isn't at this location.", 404); }
    if (!tablesCombinable(chosen)) { await removeCovers(orgId, location._id, start, end, partySize); return fail("Those tables aren't set up to be combined."); }
  } else if (type !== "table" && body.areaId) {
    chosen = tables.filter((t) => String(t.areaId) === String(body.areaId) && t.active !== false); // a private event holds the whole area
  } else if (tables.length && (source === "web" || source === "walk_in" || body.autoAssign !== false)) {
    chosen = pickTables(free, partySize, body.areaId || null);
    if (!chosen.length && (source === "web" || source === "walk_in")) {
      await removeCovers(orgId, location._id, start, end, partySize);
      return { ...fail(source === "walk_in" ? "No free table fits this party right now. Add them to the waitlist." : "No table is free for this party at that time.", 409), alternatives: source === "web" ? await nearestAlternatives(orgId, location, date, partySize, time, now) : undefined };
    }
  }
  if (chosen.length) {
    const closed = new Set(areas.filter((a) => a.closed).map((a) => String(a._id)));
    const blocked = chosen.find((t) => tableUnavailable(t, start, end, closed));
    const lock = blocked ? { conflict: true } : await setLocks(orgId, rid, chosen.map((t) => t._id), start, end);
    if (lock.conflict) {
      await removeCovers(orgId, location._id, start, end, partySize);
      return { ...fail(blocked ? `Table ${blocked.label} is closed at that time.` : "That table has just been taken for this time. Choose another table or time.", 409), alternatives: source === "web" ? await nearestAlternatives(orgId, location, date, partySize, time, now) : undefined };
    }
  }

  const policy = location.policy || {};
  const needsConfirm = source === "web" && (policy.autoConfirm === false || (policy.confirmAbovePartySize && partySize > policy.confirmAbovePartySize) || type !== "table");
  const status = source === "walk_in" ? "SEATED" : needsConfirm ? "PENDING_CONFIRMATION" : "CONFIRMED";
  const link = await linkGuest(orgId, g.guest);
  const token = newToken();
  const seq = await nextNumber(orgId, "reservation");
  const reminderAt = policy.reminderHours ? new Date(start.getTime() - policy.reminderHours * 3600000) : null;
  const doc = {
    _id: rid, orgId: org, kind: KINDS.reservation, locationId: location._id, ref: `R-${String(seq).padStart(6, "0")}`, type, status, source,
    guest: g.guest, contactId: link.contactId, matchCandidates: link.candidates, partySize, date, time, start, end, durationMinutes, timeZone: location.timeZone,
    tableIds: chosen.map((t) => t._id), areaId: chosen[0]?.areaId || oid(body.areaId) || null,
    occasion: clean(body.occasion, 80) || null, guestNote: clean(body.guestNote ?? body.note, 500) || null, preferences: clean(body.preferences, 300) || null,
    eventDetails: type !== "table" ? clean(body.eventDetails, 2000) || null : null, internalNote: source === "web" ? null : clean(body.internalNote, 1000) || null,
    marketingConsent: body.marketingConsent === true, manageTokenHash: hash(token), idempotencyKey: idem || undefined,
    reminder: reminderAt && reminderAt > now && source !== "walk_in" ? { dueAt: reminderAt, sentAt: null } : null, confirmation: {},
    history: [{ at: nowIso(), by: actorEmail || "guest", to: status }], createdByEmail: actorEmail || null, createdAt: nowIso(), updatedAt: nowIso(),
  };
  try { await c.insertOne(doc); }
  catch (e) {
    await releaseLocks(orgId, rid); await removeCovers(orgId, location._id, start, end, partySize);
    if (e?.code === 11000 && idem) { const prior = await c.findOne({ orgId: org, kind: KINDS.reservation, idempotencyKey: idem }); if (prior) return { reservation: prior, repeated: true }; }
    throw e;
  }
  // Marketing consent is separate from the booking (SOW 9.3, 14.3) and recorded with its source.
  if (doc.marketingConsent && doc.guest.email) await recordConsent({ orgId, email: doc.guest.email, source: `Reservation ${doc.ref} (${source})` }).catch(() => {});
  await logH({ orgId, recordType: "RESERVATION", recordId: rid, actorEmail: actorEmail || "guest", action: "RESERVATION_CREATED", metadata: { ref: doc.ref, source, status, partySize, date, time, tableIds: doc.tableIds.map(String), locationId: String(location._id) } });
  emitH(orgId, "reservation.created", rid, { reservation: { id: String(rid), ref: doc.ref, status, partySize, date, time, source, locationId: String(location._id) }, contactId: sid(link.contactId), contactCreated: link.created });
  const mail = source !== "walk_in" ? await sendGuest(orgId, doc, location, status === "CONFIRMED" ? "confirmed" : "pending", { token }) : { skipped: "walk_in" };
  if (status === "PENDING_CONFIRMATION") await notifyRoles({ orgId, locationId: location._id, roles: ["host"], type: "reservation_pending", sourceId: rid, title: "A reservation is waiting for confirmation", body: `${doc.ref}: party of ${partySize} on ${date} at ${time}.` });
  return { reservation: doc, token, unassigned: tables.length > 0 && !chosen.length, emailAccepted: !!mail.accepted };
}

async function nearestAlternatives(orgId, location, date, partySize, time, now) {
  try {
    const a = await availabilityFor(orgId, location, date, partySize, { now });
    const target = minutesOf(time) ?? 0;
    return a.slots.filter((s) => s.available).sort((x, y) => Math.abs(minutesOf(x.time) - target) - Math.abs(minutesOf(y.time) - target)).slice(0, 4).map((s) => s.time).sort();
  } catch { return []; }
}

export async function createReservation({ orgId, membership, actorEmail, locationId, ...body }) {
  if (!CAN.reservationsWrite(membership)) return fail("You don't have permission to take reservations.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const source = SOURCES.includes(body.source) && body.source !== "web" && body.source !== "integration" ? body.source : "staff";
  const r = await book({ orgId, location: got.location, actorEmail, body, source });
  if (r.error) return r;
  return { reservation: reservationView(r.reservation, membership), repeated: !!r.repeated, unassigned: !!r.unassigned };
}

// ---------- read ----------
async function tableMap(orgId, locationId) {
  const { tables } = await loadSeating(orgId, locationId);
  return new Map(tables.map((t) => [String(t._id), t]));
}

export async function listReservations({ orgId, membership, locationId, from, to, status, tableId, areaId, q, page = 1, limit = 100 }) {
  if (!CAN.reservationsRead(membership)) return fail("You don't have access to reservations.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const loc = got.location;
  const today = zonedDateKey(new Date(), loc.timeZone);
  const a = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : today, b = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : a;
  if (b < a || b > addDaysKey(a, 62)) return fail("Choose a range of at most 62 days.");
  const filter = { orgId: toObjectId(orgId), kind: KINDS.reservation, locationId: loc._id, date: { $gte: a, $lte: b } };
  if (status) { const list = String(status).split(",").filter((s) => STATUSES.includes(s)); if (list.length) filter.status = { $in: list }; }
  if (oid(tableId)) filter.tableIds = oid(tableId);
  if (oid(areaId)) filter.areaId = oid(areaId);
  if (q) { const s = clean(q, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = [{ "guest.name": new RegExp(s, "i") }, { ref: new RegExp(`^${s}`, "i") }]; }
  const lim = Math.min(Math.max(intIn(limit, 1, 500) ?? 100, 1), 500), pg = Math.max(intIn(page, 1, 10000) ?? 1, 1);
  const c = await hcol();
  const [rows, total, tables] = await Promise.all([c.find(filter).sort({ start: 1 }).skip((pg - 1) * lim).limit(lim).toArray(), c.countDocuments(filter), tableMap(orgId, loc._id)]);
  return { timeZone: loc.timeZone, from: a, to: b, total, page: pg, reservations: rows.map((r) => reservationView(r, membership, { tables })) };
}

async function loadReservation(orgId, membership, id) {
  const c = await hcol();
  const r = await c.findOne({ _id: oid(id), orgId: toObjectId(orgId), kind: KINDS.reservation });
  if (!r) return fail("Reservation not found.", 404);
  const got = await requireLocation(orgId, membership, r.locationId);
  if (got.error) return fail("Reservation not found.", 404);
  return { r, location: got.location };
}

export async function getReservation({ orgId, membership, id }) {
  if (!CAN.reservationsRead(membership)) return fail("You don't have access to reservations.", 403);
  const got = await loadReservation(orgId, membership, id);
  if (got.error) return got;
  const view = reservationView(got.r, membership, { tables: await tableMap(orgId, got.location._id) });
  return { reservation: { ...view, history: CAN.guestNotes(membership) ? got.r.history || [] : undefined } };
}

/** Floor view: every table with what it's doing now and next (SOW 8.3, 8.4). */
export async function floorStatus({ orgId, membership, locationId, at }) {
  if (!CAN.reservationsRead(membership)) return fail("You don't have access to the floor.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const now = at && !isNaN(new Date(at)) ? new Date(at) : new Date();
  const date = zonedDateKey(now, got.location.timeZone);
  const c = await hcol();
  const [{ areas, tables }, rows] = await Promise.all([loadSeating(orgId, got.location._id), c.find({ orgId: toObjectId(orgId), kind: KINDS.reservation, locationId: got.location._id, date, status: { $in: ACTIVE } }).sort({ start: 1 }).toArray()]);
  const closed = new Set(areas.filter((a) => a.closed).map((a) => String(a._id)));
  const brief = (r) => (r ? { id: String(r._id), ref: r.ref, guestName: r.guest?.name, partySize: r.partySize, time: r.time, end: r.end, status: r.status } : null);
  return {
    date, at: now.toISOString(), timeZone: got.location.timeZone,
    areas: areas.map((a) => ({ id: String(a._id), name: a.name, closed: !!a.closed })),
    tables: tables.map((t) => {
      const mine = rows.filter((r) => (r.tableIds || []).some((x) => String(x) === String(t._id)));
      const current = mine.find((r) => new Date(r.start) <= now && now < new Date(r.end)) || mine.find((r) => r.status === "SEATED");
      const next = mine.find((r) => new Date(r.start) > now && r !== current);
      return { ...publicTable(t), state: tableUnavailable(t, now, new Date(now.getTime() + 60000), closed) ? "closed" : current ? (current.status === "SEATED" ? "seated" : "reserved") : "free", current: brief(current), next: brief(next) };
    }),
    unassigned: rows.filter((r) => !(r.tableIds || []).length).map(brief),
  };
}

// ---------- change ----------
const freesTable = (status) => !ACTIVE.includes(status);

export async function transitionReservation({ orgId, membership, actorEmail, id, toStatus, reason, outcome, servedByEmail, now = new Date() }) {
  const got = await loadReservation(orgId, membership, id);
  if (got.error) return got;
  const { r, location } = got;
  const floorMove = ["ARRIVED", "SEATED", "COMPLETED"].includes(toStatus);
  if (!(floorMove ? CAN.serviceUpdate(membership) : CAN.reservationsWrite(membership))) return fail("You don't have permission to do that.", 403);
  if (!STATUSES.includes(toStatus) || !canTransition(r.status, toStatus)) return fail(`A reservation that is ${r.status.toLowerCase().replace(/_/g, " ")} can't be marked ${String(toStatus).toLowerCase().replace(/_/g, " ")}.`, 409);
  if (toStatus === "NO_SHOW" && now.getTime() < new Date(r.start).getTime() + (location.policy?.noShowGraceMinutes ?? 15) * 60000) return fail("It's too early to mark a no-show: the grace period hasn't passed.", 409);
  if (toStatus === "SEATED" && !(r.tableIds || []).length && (await loadSeating(orgId, location._id)).tables.length) return fail("Assign a table before seating the guest.", 409);
  const c = await hcol();
  const set = { status: toStatus, updatedAt: nowIso(), updatedByEmail: actorEmail };
  if (["CANCELLED", "DECLINED"].includes(toStatus)) set.cancelReason = clean(reason, 300) || null;
  if (toStatus === "SEATED") { set.seatedAt = nowIso(); if (servedByEmail) set.servedByEmail = normEmail(servedByEmail); }
  if (toStatus === "ARRIVED") set.arrivedAt = nowIso();
  if (toStatus === "COMPLETED") { set.completedAt = nowIso(); if (outcome) set.outcome = clean(outcome, 500); }
  if (freesTable(toStatus)) set.reminder = null;
  // Guarded on the current status so two people acting at once can't both win.
  const upd = await c.updateOne({ _id: r._id, orgId: toObjectId(orgId), kind: KINDS.reservation, status: r.status }, { $set: set, $push: { history: { at: nowIso(), by: actorEmail, from: r.status, to: toStatus, note: clean(reason, 300) || null } } });
  if (!upd.modifiedCount) return fail("This reservation was just changed by someone else. Refresh and try again.", 409);
  const next = { ...r, ...set };
  if (freesTable(toStatus)) {
    await releaseLocks(orgId, r._id);
    // A finished or cancelled booking frees its covers from now on; past slots stay counted for reports.
    const from = toStatus === "COMPLETED" ? new Date(Math.max(now.getTime(), new Date(r.start).getTime())) : new Date(r.start);
    if (from < new Date(r.end)) await removeCovers(orgId, location._id, new Date(Math.ceil(from.getTime() / SLOT_MS) * SLOT_MS), r.end, r.partySize);
  }
  await logH({ orgId, recordType: "RESERVATION", recordId: r._id, actorEmail, action: `RESERVATION_${toStatus}`, previousState: r.status, newState: toStatus, metadata: { ref: r.ref, reason: set.cancelReason || undefined } });
  emitH(orgId, `reservation.${toStatus.toLowerCase()}`, `${r._id}:${(r.history || []).length}`, { reservation: { id: String(r._id), ref: r.ref, status: toStatus, partySize: r.partySize, date: r.date, time: r.time, locationId: String(location._id) }, contactId: sid(r.contactId) });
  if (toStatus === "CONFIRMED" && r.status !== "CONFIRMED") await sendGuest(orgId, next, location, "confirmed");
  if (toStatus === "CANCELLED") await sendGuest(orgId, next, location, "cancelled", { reason: set.cancelReason });
  if (toStatus === "DECLINED") await sendGuest(orgId, next, location, "declined", { reason: set.cancelReason });
  if (toStatus === "COMPLETED") await recordVisit(orgId, next, actorEmail);
  if (freesTable(toStatus) && (r.tableIds || []).length) await tableFreed(orgId, location, r);
  return { reservation: reservationView(next, membership) };
}

/** When a table frees up and someone is waiting, tell the hosts (SOW 8.6). No guest details in the notification. */
async function tableFreed(orgId, location, r) {
  const c = await hcol();
  const waiting = await c.countDocuments({ orgId: toObjectId(orgId), kind: KINDS.waitlist, locationId: location._id, status: "WAITING" });
  emitH(orgId, "table.available", `${r._id}:${Date.now()}`, { locationId: String(location._id), tableIds: (r.tableIds || []).map(String), waiting });
  if (waiting) await notifyRoles({ orgId, locationId: location._id, roles: ["host"], type: "table_available", sourceId: `${r._id}:${nowIso().slice(0, 16)}`, title: "A table has become available", body: `${waiting} ${waiting === 1 ? "party is" : "parties are"} on the waitlist at ${location.name}.` });
}

/** Changes time, party size, tables or details. New capacity and tables are claimed before the old ones are let go. */
export async function updateReservation({ orgId, membership, actorEmail, id, now = new Date(), ...body }) {
  if (!CAN.reservationsWrite(membership)) return fail("You don't have permission to change reservations.", 403);
  const got = await loadReservation(orgId, membership, id);
  if (got.error) return got;
  const { r, location } = got;
  if (!ACTIVE.includes(r.status)) return fail("Only an active reservation can be changed.", 409);
  const set = {};
  for (const [k, max] of [["occasion", 80], ["guestNote", 500], ["preferences", 300], ["internalNote", 1000], ["eventDetails", 2000]]) if (body[k] !== undefined) set[k] = clean(body[k], max) || null;
  if (body.servedByEmail !== undefined) set.servedByEmail = normEmail(body.servedByEmail) || null;
  if (body.name !== undefined || body.email !== undefined || body.phone !== undefined) {
    const g = guestFrom({ name: body.name ?? r.guest.name, email: body.email ?? r.guest.email, phone: body.phone ?? r.guest.phone });
    if (g.error) return fail(g.error);
    set.guest = g.guest;
  }
  const partySize = body.partySize !== undefined ? intIn(body.partySize, 1, 500) : r.partySize;
  if (partySize === null) return fail("Party size must be a whole number of guests.");
  const date = body.date ?? r.date, time = body.time ?? r.time;
  const moved = date !== r.date || time !== r.time || partySize !== r.partySize || body.durationMinutes !== undefined;
  let start = new Date(r.start), end = new Date(r.end), durationMinutes = r.durationMinutes;
  if (moved) {
    const mins = minutesOf(time);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || mins === null || mins % 15) return fail("Choose a date and a time on the quarter hour.");
    start = zonedToUtc(date, time, location.timeZone);
    durationMinutes = body.durationMinutes ? intIn(body.durationMinutes, 15, 720) : date !== r.date || time !== r.time || partySize !== r.partySize ? turnMinutes(location.policy, partySize) : r.durationMinutes;
    if (durationMinutes === null || durationMinutes % 15) return fail("Length must be in quarter hours.");
    end = new Date(start.getTime() + durationMinutes * 60000);
  }
  const { areas, tables, free } = await freeTables(orgId, location, start, end, { ignoreReservationId: r._id });
  let chosen = (r.tableIds || []).map((t) => tables.find((x) => String(x._id) === String(t))).filter(Boolean);
  if (Array.isArray(body.tableIds)) {
    chosen = [...new Set(body.tableIds.map(String))].map((x) => tables.find((t) => String(t._id) === x));
    if (chosen.some((t) => !t)) return fail("One of those tables isn't at this location.", 404);
    if (!tablesCombinable(chosen)) return fail("Those tables aren't set up to be combined.");
  } else if (moved && chosen.length && (chosen.some((t) => !free.some((f) => String(f._id) === String(t._id))) || !partyFits(chosen, partySize))) {
    chosen = body.autoAssign === false ? [] : pickTables(free, partySize, r.areaId);
    if (!chosen.length && body.autoAssign !== false) return fail("No table is free for this party at the new time. Choose another time, or pick tables yourself.", 409);
  }
  const closed = new Set(areas.filter((a) => a.closed).map((a) => String(a._id)));
  const blocked = chosen.find((t) => tableUnavailable(t, start, end, closed));
  if (blocked) return fail(`Table ${blocked.label} is closed at that time.`, 409);

  if (moved) {
    // Give back the old covers, then claim the new ones; if the new slot is full, put the old ones back unconditionally.
    await removeCovers(orgId, location._id, r.start, r.end, r.partySize);
    const cap = await addCovers(orgId, location._id, start, end, partySize, body.override === true ? null : location.policy?.maxCoversPerSlot ?? null);
    if (cap.full) { await addCovers(orgId, location._id, r.start, r.end, r.partySize, null); return fail("The new time is fully booked.", 409); }
  }
  const lock = await setLocks(orgId, r._id, chosen.map((t) => t._id), start, end);
  if (lock.conflict) {
    if (moved) { await removeCovers(orgId, location._id, start, end, partySize); await addCovers(orgId, location._id, r.start, r.end, r.partySize, null); }
    return fail("One of those tables has just been taken for that time.", 409);
  }
  Object.assign(set, { partySize, date, time, start, end, durationMinutes, tableIds: chosen.map((t) => t._id), areaId: chosen[0]?.areaId || r.areaId || null, updatedAt: nowIso(), updatedByEmail: actorEmail });
  if (moved && r.reminder !== undefined) { const due = location.policy?.reminderHours ? new Date(start.getTime() - location.policy.reminderHours * 3600000) : null; set.reminder = due && due > now ? { dueAt: due, sentAt: null } : null; }
  const c = await hcol();
  await c.updateOne({ _id: r._id, orgId: toObjectId(orgId), kind: KINDS.reservation }, { $set: set, $push: { history: { at: nowIso(), by: actorEmail, change: moved ? "rescheduled" : "updated" } } });
  const next = { ...r, ...set };
  const tablesChanged = (r.tableIds || []).map(String).sort().join() !== set.tableIds.map(String).sort().join();
  await logH({ orgId, recordType: "RESERVATION", recordId: r._id, actorEmail, action: moved ? "RESERVATION_RESCHEDULED" : tablesChanged ? "TABLE_ASSIGNMENT_CHANGED" : "RESERVATION_UPDATED", metadata: { ref: r.ref, from: { date: r.date, time: r.time, partySize: r.partySize, tableIds: (r.tableIds || []).map(String) }, to: { date, time, partySize, tableIds: set.tableIds.map(String) } } });
  if (moved) {
    emitH(orgId, "reservation.changed", `${r._id}:${(r.history || []).length}`, { reservation: { id: String(r._id), ref: r.ref, status: r.status, partySize, date, time, locationId: String(location._id) }, contactId: sid(r.contactId) });
    if (date !== r.date || time !== r.time) await sendGuest(orgId, next, location, "changed");
  }
  return { reservation: reservationView(next, membership, { tables: new Map(tables.map((t) => [String(t._id), t])) }) };
}

// ---------- guests: history, duplicate review, export, erase, feedback ----------
/** A CRM contact counts as a guest only when it has a reservation at a location the caller may use; anything else is 404. */
async function guestInScope(orgId, membership, contactId) {
  const cid = oid(contactId);
  if (!cid) return null;
  const { crmContacts } = await getOrgCollections();
  const contact = await crmContacts.findOne({ _id: cid, orgId: toObjectId(orgId), deletedAt: null });
  if (!contact) return null;
  const locs = (await allowedLocations(orgId, membership)).map((l) => l._id);
  const c = await hcol();
  const any = await c.findOne({ orgId: toObjectId(orgId), kind: KINDS.reservation, contactId: cid, locationId: { $in: locs } }, { projection: { _id: 1 } });
  return any ? { contact, locs } : null;
}

export async function guestHistory({ orgId, membership, contactId }) {
  if (!CAN.guestNotes(membership)) return fail("You don't have access to guest profiles.", 403);
  const scope = await guestInScope(orgId, membership, contactId);
  if (!scope) return fail("Guest not found.", 404);
  const { contact, locs } = scope;
  const c = await hcol();
  const rows = await c.find({ orgId: toObjectId(orgId), kind: KINDS.reservation, contactId: contact._id, locationId: { $in: locs } }).sort({ start: -1 }).limit(200).toArray();
  const done = rows.filter((r) => r.status === "COMPLETED");
  return {
    guest: { contactId: String(contact._id), name: contact.name, email: contact.email || null, phone: contact.phone || null, tags: contact.tags || [], preferences: contact.hospitality?.preferences || null, preferredChannel: contact.hospitality?.preferredChannel || null },
    summary: { reservations: rows.length, visits: done.length, noShows: rows.filter((r) => r.status === "NO_SHOW").length, cancellations: rows.filter((r) => r.status === "CANCELLED").length, lastVisitAt: done[0]?.start || null },
    reservations: rows.map((r) => reservationView(r, membership)),
  };
}

export async function updateGuestProfile({ orgId, membership, actorEmail, contactId, preferences, preferredChannel, preferredLocationId }) {
  if (!CAN.guestNotes(membership)) return fail("You don't have access to guest profiles.", 403);
  if (!(await guestInScope(orgId, membership, contactId))) return fail("Guest not found.", 404);
  const { crmContacts } = await getOrgCollections();
  const set = { updatedAt: nowIso() };
  if (preferences !== undefined) set["hospitality.preferences"] = clean(preferences, 500) || null;
  if (preferredChannel !== undefined) { if (preferredChannel && !["email", "phone", "sms"].includes(preferredChannel)) return fail("Preferred channel must be email, phone or sms."); set["hospitality.preferredChannel"] = preferredChannel || null; }
  if (preferredLocationId !== undefined) { if (preferredLocationId) { const g = await requireLocation(orgId, membership, preferredLocationId); if (g.error) return g; } set["hospitality.preferredLocationId"] = oid(preferredLocationId); }
  const r = await crmContacts.updateOne({ _id: oid(contactId), orgId: toObjectId(orgId), deletedAt: null }, { $set: set });
  if (!r.matchedCount) return fail("Guest not found.", 404);
  await logH({ orgId, recordType: "GUEST", recordId: contactId, actorEmail, action: "GUEST_PROFILE_UPDATED", metadata: { fields: Object.keys(set) } });
  return { ok: true };
}

/** Reservations whose guest might already be in the CRM (phone match). A manager links or dismisses each one. */
export async function listDuplicateReviews({ orgId, membership }) {
  if (!CAN.manage(membership)) return fail("Only a manager can review possible duplicates.", 403);
  const locs = (await allowedLocations(orgId, membership)).map((l) => l._id);
  const c = await hcol();
  const rows = await c.find({ orgId: toObjectId(orgId), kind: KINDS.reservation, locationId: { $in: locs }, contactId: null, "matchCandidates.0": { $exists: true } }).sort({ createdAt: -1 }).limit(100).toArray();
  const { crmContacts } = await getOrgCollections();
  const ids = [...new Set(rows.flatMap((r) => r.matchCandidates.map(String)))].map((x) => toObjectId(x));
  const contacts = new Map((await crmContacts.find({ _id: { $in: ids }, orgId: toObjectId(orgId), deletedAt: null }).project({ name: 1, email: 1, phone: 1 }).toArray()).map((x) => [String(x._id), x]));
  return { reviews: rows.map((r) => ({ reservationId: String(r._id), ref: r.ref, guest: r.guest, date: r.date, candidates: r.matchCandidates.map((x) => contacts.get(String(x))).filter(Boolean).map((x) => ({ contactId: String(x._id), name: x.name, email: x.email || null, phone: x.phone || null })) })) };
}

export async function resolveDuplicate({ orgId, membership, actorEmail, reservationId, contactId }) {
  if (!CAN.manage(membership)) return fail("Only a manager can review possible duplicates.", 403);
  const got = await loadReservation(orgId, membership, reservationId);
  if (got.error) return got;
  const c = await hcol();
  if (contactId) {
    if (!(got.r.matchCandidates || []).some((x) => String(x) === String(contactId))) return fail("That contact wasn't one of the suggested matches.");
    await c.updateOne({ _id: got.r._id }, { $set: { contactId: toObjectId(contactId), matchCandidates: [], updatedAt: nowIso() } });
  } else await c.updateOne({ _id: got.r._id }, { $set: { matchCandidates: [], updatedAt: nowIso() } });
  await logH({ orgId, recordType: "GUEST", recordId: got.r._id, actorEmail, action: contactId ? "GUEST_LINKED_AFTER_REVIEW" : "GUEST_MATCH_DISMISSED", metadata: { ref: got.r.ref, contactId: contactId || null } });
  return { ok: true };
}

export async function exportGuest({ orgId, membership, actorEmail, contactId }) {
  if (!CAN.guestExport(membership)) return fail("Only a manager can export guest data.", 403);
  const h = await guestHistory({ orgId, membership, contactId });
  if (h.error) return h;
  await logH({ orgId, recordType: "GUEST", recordId: contactId, actorEmail, action: "GUEST_DATA_EXPORTED", metadata: { reservations: h.reservations.length } });
  return { exportedAt: nowIso(), ...h };
}

/** Removes a guest's personal details from their reservations (the booking counts are kept for reports). The CRM contact itself is deleted in CRM. */
export async function eraseGuest({ orgId, membership, actorEmail, contactId, confirm, reason }) {
  if (!CAN.guestExport(membership)) return fail("Only a manager can erase guest data.", 403);
  if (confirm !== "ERASE") return fail('Type ERASE to confirm. This can\'t be undone.');
  if (!clean(reason, 300)) return fail("Give a reason for the record.");
  // Never run the update below without a real contact id: a null id would match every unlinked reservation.
  if (!(await guestInScope(orgId, membership, contactId))) return fail("Guest not found.", 404);
  const c = await hcol();
  const org = toObjectId(orgId), cid = oid(contactId);
  const open = await c.countDocuments({ orgId: org, kind: KINDS.reservation, contactId: cid, status: { $in: ACTIVE } });
  if (open) return fail("This guest has upcoming reservations. Cancel or complete them first.", 409);
  const r = await c.updateMany({ orgId: org, kind: KINDS.reservation, contactId: cid }, { $set: { guest: { name: "Erased guest", email: null, phone: null }, contactId: null, guestNote: null, preferences: null, internalNote: null, occasion: null, feedback: null, erasedAt: nowIso() } });
  await c.updateMany({ orgId: org, kind: KINDS.waitlist, contactId: cid }, { $set: { guest: { name: "Erased guest", email: null, phone: null }, contactId: null, note: null } });
  const { crmContacts } = await getOrgCollections();
  await crmContacts.updateOne({ _id: cid, orgId: org }, { $unset: { hospitality: "" } });
  await logH({ orgId, recordType: "GUEST", recordId: contactId, actorEmail, action: "GUEST_DATA_ERASED", metadata: { reservations: r.modifiedCount, reason: clean(reason, 300) } });
  return { ok: true, reservationsAnonymised: r.modifiedCount };
}

export async function recordFeedback({ orgId, membership, actorEmail, id, rating, comment }) {
  if (!CAN.serviceUpdate(membership)) return fail("You don't have permission to record feedback.", 403);
  const got = await loadReservation(orgId, membership, id);
  if (got.error) return got;
  return saveFeedback(orgId, got.r, { rating, comment, by: actorEmail });
}

async function saveFeedback(orgId, r, { rating, comment, by }) {
  if (r.status !== "COMPLETED") return fail("Feedback can be recorded once the visit is completed.", 409);
  const n = intIn(rating, 1, 5);
  if (n === null) return fail("Rating must be from 1 to 5.");
  const feedback = { rating: n, comment: clean(comment, 1000) || null, at: nowIso(), by };
  await (await hcol()).updateOne({ _id: r._id }, { $set: { feedback, updatedAt: nowIso() } });
  await logH({ orgId, recordType: "RESERVATION", recordId: r._id, actorEmail: by, action: "FEEDBACK_RECORDED", metadata: { ref: r.ref, rating: n } });
  emitH(orgId, "feedback.submitted", r._id, { reservation: { id: String(r._id), ref: r.ref, locationId: String(r.locationId) }, rating: n, contactId: sid(r.contactId) });
  return { feedback };
}

// ---------- waitlist ----------
const waitView = (w, m) => ({ id: sid(w._id), locationId: sid(w.locationId), status: w.status, partySize: w.partySize, preferredTime: w.preferredTime || null, quotedMinutes: w.quotedMinutes ?? null, note: w.note || null, guest: { name: w.guest.name, ...(CAN.guestNotes(m) ? { email: w.guest.email, phone: w.guest.phone } : {}) }, contactId: sid(w.contactId), reservationId: sid(w.reservationId), invitedAt: w.invitedAt || null, createdAt: w.createdAt });

export async function listWaitlist({ orgId, membership, locationId, includeClosed }) {
  if (!CAN.reservationsRead(membership)) return fail("You don't have access to the waitlist.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const c = await hcol();
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const rows = await c.find({ orgId: toObjectId(orgId), kind: KINDS.waitlist, locationId: got.location._id, ...(includeClosed ? { createdAt: { $gte: since } } : { status: { $in: ["WAITING", "INVITED"] } }) }).sort({ createdAt: 1 }).limit(300).toArray();
  return { waitlist: rows.map((w) => waitView(w, membership)) };
}

export async function addToWaitlist({ orgId, membership, actorEmail, locationId, ...body }) {
  if (!CAN.reservationsWrite(membership)) return fail("You don't have permission to manage the waitlist.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const g = guestFrom(body);
  if (g.error) return fail(g.error);
  const partySize = intIn(body.partySize, 1, 100);
  if (partySize === null) return fail("Party size must be a whole number of guests.");
  // A wait time is only stored when staff quote one; the system doesn't promise one it can't calculate (SOW 8.6).
  const quoted = body.quotedMinutes === undefined || body.quotedMinutes === null || body.quotedMinutes === "" ? null : intIn(body.quotedMinutes, 0, 600);
  const link = await linkGuest(orgId, g.guest);
  const doc = { orgId: toObjectId(orgId), kind: KINDS.waitlist, locationId: got.location._id, status: "WAITING", guest: g.guest, contactId: link.contactId, partySize, preferredTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(body.preferredTime || "") ? body.preferredTime : null, quotedMinutes: quoted, note: clean(body.note, 300) || null, createdByEmail: actorEmail, createdAt: nowIso(), updatedAt: nowIso() };
  const r = await (await hcol()).insertOne(doc);
  await logH({ orgId, recordType: "WAITLIST", recordId: r.insertedId, actorEmail, action: "WAITLIST_ADDED", metadata: { partySize, locationId: String(got.location._id) } });
  emitH(orgId, "waitlist.created", r.insertedId, { waitlist: { id: String(r.insertedId), partySize, locationId: String(got.location._id) } });
  return { entry: waitView({ ...doc, _id: r.insertedId }, membership) };
}

/** Pure: the first waiting party (oldest first) that the given free tables can seat. */
export function nextSuitableParty(waiting, freeTables) {
  return waiting.find((w) => pickTables(freeTables, w.partySize).length) || null;
}

export async function suggestNextParty({ orgId, membership, locationId, now = new Date() }) {
  if (!CAN.reservationsRead(membership)) return fail("You don't have access to the waitlist.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const c = await hcol();
  const waiting = await c.find({ orgId: toObjectId(orgId), kind: KINDS.waitlist, locationId: got.location._id, status: "WAITING" }).sort({ createdAt: 1 }).limit(200).toArray();
  const start = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS);
  const result = [];
  for (const w of waiting) {
    const end = new Date(start.getTime() + turnMinutes(got.location.policy, w.partySize) * 60000);
    const { free } = await freeTables(orgId, got.location, start, end);
    const t = pickTables(free, w.partySize);
    if (t.length) { result.push({ entry: waitView(w, membership), tables: t.map(publicTable) }); break; }
  }
  return { suggestion: result[0] || null, waiting: waiting.length };
}

export async function updateWaitlist({ orgId, membership, actorEmail, id, action, tableIds, holdMinutes }) {
  if (!CAN.reservationsWrite(membership)) return fail("You don't have permission to manage the waitlist.", 403);
  const c = await hcol();
  const w = await c.findOne({ _id: oid(id), orgId: toObjectId(orgId), kind: KINDS.waitlist });
  if (!w) return fail("Waitlist entry not found.", 404);
  const got = await requireLocation(orgId, membership, w.locationId);
  if (got.error) return fail("Waitlist entry not found.", 404);
  if (!["WAITING", "INVITED"].includes(w.status)) return fail("This entry is already closed.", 409);
  if (action === "invite") {
    let emailed = false;
    if (isEmail(w.guest.email)) { try { await sendEmail({ to: w.guest.email, ...waitlistInviteEmail({ entry: w, location: got.location, business: got.location.senderName || (await businessName(orgId)), holdMinutes: intIn(holdMinutes, 1, 120) }) }); emailed = true; } catch { emailed = false; } }
    await c.updateOne({ _id: w._id }, { $set: { status: "INVITED", invitedAt: nowIso(), invitedByEmail: actorEmail, updatedAt: nowIso() } });
    await logH({ orgId, recordType: "WAITLIST", recordId: w._id, actorEmail, action: "WAITLIST_INVITED", metadata: { emailed } });
    return { entry: waitView({ ...w, status: "INVITED", invitedAt: nowIso() }, membership), emailed };
  }
  if (action === "seat") {
    const r = await book({ orgId, location: got.location, actorEmail, source: "walk_in", body: { name: w.guest.name, email: w.guest.email, phone: w.guest.phone, partySize: w.partySize, tableIds: Array.isArray(tableIds) && tableIds.length ? tableIds : undefined, guestNote: w.note } });
    if (r.error) return r;
    await c.updateOne({ _id: w._id }, { $set: { status: "SEATED", reservationId: r.reservation._id, seatedAt: nowIso(), updatedAt: nowIso() } });
    await logH({ orgId, recordType: "WAITLIST", recordId: w._id, actorEmail, action: "WAITLIST_SEATED", metadata: { reservationRef: r.reservation.ref } });
    return { entry: waitView({ ...w, status: "SEATED", reservationId: r.reservation._id }, membership), reservation: reservationView(r.reservation, membership) };
  }
  if (action === "cancel" || action === "expire") {
    const status = action === "cancel" ? "CANCELLED" : "EXPIRED";
    await c.updateOne({ _id: w._id }, { $set: { status, updatedAt: nowIso() } });
    await logH({ orgId, recordType: "WAITLIST", recordId: w._id, actorEmail, action: `WAITLIST_${status}` });
    return { entry: waitView({ ...w, status }, membership) };
  }
  return fail("Unknown waitlist action.");
}

// ---------- public booking page (SOW 8.8) ----------
async function locationBySlug(slug) {
  const c = await hcol();
  const s = clean(slug, 40).toLowerCase();
  const loc = s ? await c.findOne({ kind: KINDS.location, publicSlug: s, deletedAt: null }) : null;
  if (!loc || !loc.onlineBooking) return null;
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: loc.orgId }, { projection: { name: 1, vertical: 1, industry: 1 } });
  return org ? { loc, org } : null;
}

/** Only what a guest needs to book: never staff, guest or internal data. */
export async function publicInfo(slug) {
  const f = await locationBySlug(slug);
  if (!f) return fail("This booking page isn't available.", 404);
  const { loc, org } = f;
  const { areas } = await loadSeating(loc.orgId, loc._id);
  return { business: loc.senderName || org.name, location: { name: loc.name, address: loc.address || null, phone: loc.phone || null, timeZone: loc.timeZone, hours: loc.hours, closures: (loc.closures || []).map((c) => c.date) }, policy: { maxPartyOnline: loc.policy.maxPartyOnline, horizonDays: loc.policy.horizonDays, cancelNoticeHours: loc.policy.cancelNoticeHours, policyText: loc.policy.policyText || "", needsConfirmation: loc.policy.autoConfirm === false }, areas: areas.filter((a) => !a.closed).map((a) => ({ id: String(a._id), name: a.name })) };
}

export async function publicSlots(slug, date, partySize) {
  const f = await locationBySlug(slug);
  if (!f) return fail("This booking page isn't available.", 404);
  const n = intIn(partySize, 1, f.loc.policy.maxPartyOnline ?? 8);
  if (n === null) return fail(`Online booking is for parties of up to ${f.loc.policy.maxPartyOnline ?? 8}.`);
  const a = await availabilityFor(f.loc.orgId, f.loc, clean(date, 10), n);
  return { date: a.date, partySize: n, timeZone: a.timeZone, slots: a.slots.filter((s) => s.available).map((s) => ({ time: s.time, period: s.period })) };
}

export async function publicBook(slug, body = {}) {
  const f = await locationBySlug(slug);
  if (!f) return fail("This booking page isn't available.", 404);
  if (body.website) return { ok: true, ref: null }; // honeypot: bots fill the hidden field; pretend success, store nothing
  if (!isEmail(body.email)) return fail("An email address is needed so we can send your confirmation.");
  if (!clean(body.idempotencyKey, 80)) return fail("Missing request id. Reload the page and try again.");
  const r = await book({ orgId: String(f.loc.orgId), location: f.loc, actorEmail: null, source: "web", body: { name: body.name, email: body.email, phone: body.phone, partySize: body.partySize, date: body.date, time: body.time, occasion: body.occasion, guestNote: body.note, preferences: body.preferences, areaId: body.areaId, marketingConsent: body.marketingConsent === true, idempotencyKey: `web:${clean(body.idempotencyKey, 70)}` } });
  if (r.error) return r;
  const x = r.reservation;
  return { ok: true, ref: x.ref, status: x.status, date: x.date, time: x.time, partySize: x.partySize, manageToken: r.token || null, emailSent: r.repeated ? null : !!r.emailAccepted };
}

async function byToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const c = await hcol();
  const r = await c.findOne({ kind: KINDS.reservation, manageTokenHash: hash(token) });
  if (!r) return null;
  if (Date.now() > new Date(r.end).getTime() + 7 * 86400000) return null; // links stop working a week after the visit
  const loc = await c.findOne({ _id: r.locationId, orgId: r.orgId, kind: KINDS.location });
  return loc ? { r, loc } : null;
}

const guestSafe = (r, loc, business) => ({ ref: r.ref, status: r.status, date: r.date, time: r.time, partySize: r.partySize, timeZone: r.timeZone, name: r.guest?.name, occasion: r.occasion || null, business, location: { name: loc.name, address: loc.address || null, phone: loc.phone || null }, canCancel: ["REQUESTED", "PENDING_CONFIRMATION", "CONFIRMED"].includes(r.status) && Date.now() < new Date(r.start).getTime() - (loc.policy?.cancelNoticeHours ?? 0) * 3600000, cancelNoticeHours: loc.policy?.cancelNoticeHours ?? 0, canGiveFeedback: r.status === "COMPLETED" && !r.feedback, feedbackGiven: !!r.feedback });

export async function publicManageView(token) {
  const f = await byToken(token);
  if (!f) return fail("This link has expired or isn't valid.", 404);
  return { reservation: guestSafe(f.r, f.loc, f.loc.senderName || (await businessName(String(f.r.orgId)))) };
}

export async function publicManageAction(token, { action, reason, rating, comment } = {}) {
  const f = await byToken(token);
  if (!f) return fail("This link has expired or isn't valid.", 404);
  const { r, loc } = f;
  const orgId = String(r.orgId);
  if (action === "feedback") { const fb = await saveFeedback(orgId, r, { rating, comment, by: "guest" }); return fb.error ? fb : { ok: true }; }
  if (action !== "cancel") return fail("Unknown action.");
  if (!guestSafe(r, loc, "").canCancel) return fail(`This reservation can no longer be cancelled online. Please call ${loc.phone || "the restaurant"}.`, 409);
  const c = await hcol();
  const upd = await c.updateOne({ _id: r._id, status: r.status }, { $set: { status: "CANCELLED", cancelReason: clean(reason, 300) || "Cancelled by guest", reminder: null, updatedAt: nowIso() }, $push: { history: { at: nowIso(), by: "guest", from: r.status, to: "CANCELLED" } } });
  if (!upd.modifiedCount) return fail("This reservation has just changed. Reload the page.", 409);
  await releaseLocks(orgId, r._id);
  await removeCovers(orgId, loc._id, r.start, r.end, r.partySize);
  await logH({ orgId, recordType: "RESERVATION", recordId: r._id, actorEmail: "guest", action: "RESERVATION_CANCELLED", previousState: r.status, newState: "CANCELLED", metadata: { ref: r.ref, by: "guest" } });
  emitH(orgId, "reservation.cancelled", `${r._id}:guest`, { reservation: { id: String(r._id), ref: r.ref, status: "CANCELLED", partySize: r.partySize, date: r.date, time: r.time, locationId: String(loc._id) }, contactId: sid(r.contactId), by: "guest" });
  await sendGuest(orgId, { ...r, status: "CANCELLED" }, loc, "cancelled", { reason: "Cancelled at your request" });
  await notifyRoles({ orgId, locationId: loc._id, roles: ["host"], type: "reservation_cancelled_by_guest", sourceId: r._id, title: "A guest cancelled a reservation", body: `${r.ref}: party of ${r.partySize} on ${r.date} at ${r.time}.` });
  if ((r.tableIds || []).length) await tableFreed(orgId, loc, r);
  return { ok: true };
}

// ---------- reminders (called from the existing engagement cron) ----------
export async function processReservationReminders({ now = new Date(), limit = 100 } = {}) {
  const c = await hcol();
  const due = await c.find({ kind: KINDS.reservation, status: "CONFIRMED", "reminder.dueAt": { $lte: now }, "reminder.sentAt": null, start: { $gt: now } }).limit(limit).toArray();
  let sent = 0, failed = 0;
  for (const r of due) {
    // Claim first so a second cron run can't send the same reminder (idempotent).
    const claim = await c.updateOne({ _id: r._id, "reminder.sentAt": null }, { $set: { "reminder.sentAt": nowIso() } });
    if (!claim.modifiedCount) continue;
    const loc = await c.findOne({ _id: r.locationId, orgId: r.orgId, kind: KINDS.location });
    const out = loc ? await sendGuest(String(r.orgId), r, loc, "reminder") : { failed: true };
    if (out.accepted) sent++; else if (out.failed) failed++;
  }
  return { due: due.length, sent, failed };
}

/** Guest directory: CRM contacts who have a reservation at a location the caller may see (SOW 9.1). */
export async function listGuests({ orgId, membership, q, limit = 100 }) {
  if (!CAN.guestNotes(membership)) return fail("You don't have access to guest profiles.", 403);
  const locs = (await allowedLocations(orgId, membership)).map((l) => l._id);
  const c = await hcol();
  const rows = await c.aggregate([
    { $match: { orgId: toObjectId(orgId), kind: KINDS.reservation, locationId: { $in: locs }, contactId: { $ne: null } } },
    { $group: { _id: "$contactId", reservations: { $sum: 1 }, visits: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } }, last: { $max: "$start" } } },
    { $sort: { last: -1 } }, { $limit: 2000 },
  ]).toArray();
  const { crmContacts } = await getOrgCollections();
  const filter = { _id: { $in: rows.map((r) => r._id) }, orgId: toObjectId(orgId), deletedAt: null };
  if (q) { const s = clean(q, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = [{ name: new RegExp(s, "i") }, { email: new RegExp(s, "i") }, { phone: new RegExp(s, "i") }]; }
  const contacts = new Map((await crmContacts.find(filter).project({ name: 1, email: 1, phone: 1 }).toArray()).map((x) => [String(x._id), x]));
  const lim = Math.min(Math.max(intIn(limit, 1, 500) ?? 100, 1), 500);
  return { guests: rows.filter((r) => contacts.has(String(r._id))).slice(0, lim).map((r) => { const x = contacts.get(String(r._id)); return { contactId: String(r._id), name: x.name, email: x.email || null, phone: x.phone || null, reservations: r.reservations, visits: r.visits, lastReservationAt: r.last }; }) };
}
