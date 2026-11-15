// src/lib/hospitality/locations.js
//
// Locations (SOW 7), business hours, reservation policies, seating areas and tables (SOW 8.4).
// A location is NOT a warehouse: it may point at one (`warehouseId`) for stock, but neither is derived from the other.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { isValidTimeZone, DAY_KEYS, minutesOf, zonedToUtc } from "../engagement/time.js";
import { hcol, KINDS, CAN, fail, clean, nowIso, oid, sid, intIn, isEmail, normEmail, logH, requireLocation, allowedLocations, listLocationDocs, ensureHospitalityIndexes } from "./store.js";

export const DEFAULT_POLICY = {
  slotMinutes: 15, leadMinutes: 60, horizonDays: 60, maxPartyOnline: 8, maxCoversPerSlot: null, autoConfirm: true, confirmAbovePartySize: null,
  cancelNoticeHours: 2, noShowGraceMinutes: 15, reminderHours: 24, lastSeatingMinutes: 60, policyText: "",
  turnTimes: [{ maxParty: 2, minutes: 90 }, { maxParty: 4, minutes: 105 }, { maxParty: 6, minutes: 120 }, { maxParty: 99, minutes: 150 }],
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Pure: validates { mon:[{from,to,label}], ... }. Periods must sit on the 15-minute grid and not overlap. */
export function normalizeHours(input = {}) {
  const out = {};
  for (const d of DAY_KEYS) {
    const periods = Array.isArray(input[d]) ? input[d] : [];
    if (periods.length > 6) return { error: "At most 6 service periods a day." };
    const list = [];
    for (const p of periods) {
      if (!HHMM.test(p?.from || "") || !HHMM.test(p?.to || "")) return { error: "Times must look like 18:30." };
      const a = minutesOf(p.from), b = minutesOf(p.to);
      if (a % 15 || b % 15) return { error: "Service periods must start and end on a quarter hour." };
      if (b <= a) return { error: "A service period must end after it starts (periods can't run past midnight)." };
      list.push({ from: p.from, to: p.to, label: clean(p.label, 40) || null });
    }
    list.sort((x, y) => minutesOf(x.from) - minutesOf(y.from));
    for (let i = 1; i < list.length; i++) if (minutesOf(list[i].from) < minutesOf(list[i - 1].to)) return { error: "Service periods on the same day can't overlap." };
    out[d] = list;
  }
  return { hours: out };
}

/** Pure: merges a partial policy over the defaults and validates it. */
export function normalizePolicy(input = {}, base = DEFAULT_POLICY) {
  const p = { ...base, ...input };
  const out = {};
  out.slotMinutes = [15, 30, 60].includes(Number(p.slotMinutes)) ? Number(p.slotMinutes) : null;
  out.leadMinutes = intIn(p.leadMinutes, 0, 7 * 24 * 60);
  out.horizonDays = intIn(p.horizonDays, 1, 365);
  out.maxPartyOnline = intIn(p.maxPartyOnline, 1, 100);
  out.cancelNoticeHours = intIn(p.cancelNoticeHours, 0, 168);
  out.noShowGraceMinutes = intIn(p.noShowGraceMinutes, 0, 240);
  out.reminderHours = intIn(p.reminderHours, 0, 168);
  out.lastSeatingMinutes = intIn(p.lastSeatingMinutes, 0, 240);
  for (const [k, v] of Object.entries(out)) if (v === null) return { error: `${k} is out of range.` };
  out.maxCoversPerSlot = p.maxCoversPerSlot === null || p.maxCoversPerSlot === "" || p.maxCoversPerSlot === undefined ? null : intIn(p.maxCoversPerSlot, 1, 5000);
  if (p.maxCoversPerSlot && out.maxCoversPerSlot === null) return { error: "maxCoversPerSlot must be a whole number." };
  out.confirmAbovePartySize = p.confirmAbovePartySize === null || p.confirmAbovePartySize === "" || p.confirmAbovePartySize === undefined ? null : intIn(p.confirmAbovePartySize, 1, 100);
  out.autoConfirm = p.autoConfirm !== false;
  out.policyText = clean(p.policyText, 1000);
  const tt = Array.isArray(p.turnTimes) ? p.turnTimes : [];
  if (!tt.length || tt.length > 8) return { error: "Give between 1 and 8 turn times." };
  out.turnTimes = [];
  for (const t of tt) {
    const mp = intIn(t?.maxParty, 1, 999), mins = intIn(t?.minutes, 15, 600);
    if (mp === null || mins === null || mins % 15) return { error: "Turn times need a party size and a length in quarter hours." };
    out.turnTimes.push({ maxParty: mp, minutes: mins });
  }
  out.turnTimes.sort((a, b) => a.maxParty - b.maxParty);
  return { policy: out };
}

/** Pure: how long a party of `size` holds its table. */
export function turnMinutes(policy, size) {
  const tt = policy?.turnTimes?.length ? policy.turnTimes : DEFAULT_POLICY.turnTimes;
  return (tt.find((t) => size <= t.maxParty) || tt[tt.length - 1]).minutes;
}

export const publicLocation = (l) => ({
  id: sid(l._id), name: l.name, code: l.code || null, address: l.address || null, timeZone: l.timeZone, phone: l.phone || null, email: l.email || null, currency: l.currency,
  hours: l.hours, closures: l.closures || [], policy: l.policy, publicSlug: l.publicSlug || null, onlineBooking: !!l.onlineBooking, warehouseId: sid(l.warehouseId), senderName: l.senderName || null,
  createdAt: l.createdAt, updatedAt: l.updatedAt,
});

export async function listLocations(orgId, m) {
  await ensureHospitalityIndexes();
  return { locations: (await allowedLocations(orgId, m)).map(publicLocation) };
}

async function fieldsFrom(orgId, body, existing = null) {
  const set = {};
  if (body.name !== undefined || !existing) { const n = clean(body.name, 80); if (!n) return fail("Give the location a name."); set.name = n; }
  if (body.code !== undefined) set.code = clean(body.code, 20) || null;
  if (body.address !== undefined) set.address = clean(body.address, 300) || null;
  if (body.phone !== undefined) set.phone = clean(body.phone, 40) || null;
  if (body.email !== undefined) { const e = normEmail(body.email); if (e && !isEmail(e)) return fail("That email address doesn't look right."); set.email = e || null; }
  if (body.senderName !== undefined) set.senderName = clean(body.senderName, 80) || null;
  if (body.timeZone !== undefined || !existing) { if (!isValidTimeZone(body.timeZone)) return fail("Choose a valid time zone, for example Asia/Karachi."); set.timeZone = body.timeZone; }
  if (body.currency !== undefined || !existing) { const c = String(body.currency ?? "").trim().toUpperCase(); if (!CURRENCY.test(c)) return fail("Choose a three-letter currency code, for example PKR or USD."); set.currency = c; }
  if (body.hours !== undefined || !existing) { const h = normalizeHours(body.hours || {}); if (h.error) return fail(h.error); set.hours = h.hours; }
  if (body.policy !== undefined || !existing) { const p = normalizePolicy(body.policy || {}, existing?.policy || DEFAULT_POLICY); if (p.error) return fail(p.error); set.policy = p.policy; }
  if (body.closures !== undefined) {
    const list = Array.isArray(body.closures) ? body.closures : [];
    if (list.length > 120) return fail("At most 120 closure dates.");
    const out = [];
    for (const c of list) { if (!/^\d{4}-\d{2}-\d{2}$/.test(c?.date || "")) return fail("Closure dates must look like 2026-12-25."); out.push({ date: c.date, reason: clean(c.reason, 120) || null }); }
    set.closures = out;
  }
  if (body.onlineBooking !== undefined) set.onlineBooking = body.onlineBooking === true;
  if (body.publicSlug !== undefined) {
    const s = clean(body.publicSlug, 40).toLowerCase();
    if (s && !SLUG.test(s)) return fail("The web address may use lowercase letters, numbers and hyphens (3 to 40 characters).");
    if (s === "manage") return fail("That web address is reserved. Choose another.");
    set.publicSlug = s || null;
  }
  if (body.warehouseId !== undefined) {
    if (!body.warehouseId) set.warehouseId = null;
    else {
      const { warehouses } = await getOrgCollections();
      const w = await warehouses.findOne({ _id: oid(body.warehouseId), orgId: toObjectId(orgId) });
      if (!w) return fail("That stock location wasn't found.", 404);
      set.warehouseId = w._id;
    }
  }
  return { set };
}

export async function createLocation({ orgId, membership, actorEmail, ...body }) {
  if (!CAN.manage(membership)) return fail("Only a manager can add a location.", 403);
  await ensureHospitalityIndexes();
  if ((await listLocationDocs(orgId)).length >= 100) return fail("A company can have at most 100 locations.");
  const f = await fieldsFrom(orgId, body);
  if (f.error) return f;
  const c = await hcol();
  const doc = { orgId: toObjectId(orgId), kind: KINDS.location, closures: [], onlineBooking: false, publicSlug: null, warehouseId: null, ...f.set, createdByEmail: actorEmail, createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null };
  try { const r = await c.insertOne(doc); doc._id = r.insertedId; }
  catch (e) { if (e?.code === 11000) return fail("That web address is already taken. Choose another.", 409); throw e; }
  await logH({ orgId, recordType: "LOCATION", recordId: doc._id, actorEmail, action: "LOCATION_CREATED", metadata: { name: doc.name } });
  return { location: publicLocation(doc) };
}

export async function updateLocation({ orgId, membership, actorEmail, locationId, ...body }) {
  if (!CAN.manage(membership)) return fail("Only a manager can change a location.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const f = await fieldsFrom(orgId, body, got.location);
  if (f.error) return f;
  if (f.set.onlineBooking === true && !(f.set.publicSlug ?? got.location.publicSlug)) return fail("Choose a web address before turning online booking on.");
  const c = await hcol();
  try { await c.updateOne({ _id: got.location._id, orgId: toObjectId(orgId), kind: KINDS.location }, { $set: { ...f.set, updatedAt: nowIso(), updatedByEmail: actorEmail } }); }
  catch (e) { if (e?.code === 11000) return fail("That web address is already taken. Choose another.", 409); throw e; }
  await logH({ orgId, recordType: "LOCATION", recordId: got.location._id, actorEmail, action: "LOCATION_UPDATED", metadata: { fields: Object.keys(f.set) } });
  return { location: publicLocation({ ...got.location, ...f.set }) };
}

// ---- seating areas and tables ----
const publicArea = (a) => ({ id: sid(a._id), locationId: sid(a.locationId), name: a.name, order: a.order || 0, closed: !!a.closed });
export const publicTable = (t) => ({ id: sid(t._id), locationId: sid(t.locationId), areaId: sid(t.areaId), label: t.label, minParty: t.minParty, maxParty: t.maxParty, combinableWith: (t.combinableWith || []).map(String), active: t.active !== false, blocks: t.blocks || [] });

export async function loadSeating(orgId, locationId) {
  const c = await hcol();
  const org = toObjectId(orgId), loc = toObjectId(locationId);
  const [areas, tables] = await Promise.all([
    c.find({ orgId: org, kind: KINDS.area, locationId: loc, deletedAt: null }).sort({ order: 1, name: 1 }).limit(100).toArray(),
    c.find({ orgId: org, kind: KINDS.table, locationId: loc, deletedAt: null }).sort({ label: 1 }).limit(500).toArray(),
  ]);
  return { areas, tables };
}

export async function getSeating({ orgId, membership, locationId }) {
  if (!CAN.reservationsRead(membership)) return fail("You don't have access to seating.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const { areas, tables } = await loadSeating(orgId, got.location._id);
  return { areas: areas.map(publicArea), tables: tables.map(publicTable) };
}

export async function saveArea({ orgId, membership, actorEmail, locationId, areaId, name, order, closed }) {
  if (!CAN.manage(membership)) return fail("Only a manager can change seating areas.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const n = clean(name, 60);
  if (!n) return fail("Give the area a name, for example Patio.");
  const c = await hcol();
  const set = { name: n, order: intIn(order, 0, 999) ?? 0, closed: closed === true, updatedAt: nowIso() };
  if (areaId) {
    const r = await c.updateOne({ _id: oid(areaId), orgId: toObjectId(orgId), kind: KINDS.area, locationId: got.location._id, deletedAt: null }, { $set: set });
    if (!r.matchedCount) return fail("Area not found.", 404);
    await logH({ orgId, recordType: "AREA", recordId: areaId, actorEmail, action: "AREA_UPDATED", metadata: set });
    return { area: publicArea({ _id: oid(areaId), locationId: got.location._id, ...set }) };
  }
  const doc = { orgId: toObjectId(orgId), kind: KINDS.area, locationId: got.location._id, ...set, createdAt: nowIso(), deletedAt: null };
  const r = await c.insertOne(doc);
  await logH({ orgId, recordType: "AREA", recordId: r.insertedId, actorEmail, action: "AREA_CREATED", metadata: { name: n } });
  return { area: publicArea({ ...doc, _id: r.insertedId }) };
}

/** Pure: validates table fields. `blocks` are temporary closures [{ from, to, reason }] in ISO time. */
export function normalizeTable(input = {}) {
  const label = clean(input.label, 20);
  if (!label) return { error: "Give the table a number or name." };
  const minParty = intIn(input.minParty ?? 1, 1, 200), maxParty = intIn(input.maxParty, 1, 200);
  if (minParty === null || maxParty === null || maxParty < minParty) return { error: "Seats: the largest party must be at least the smallest." };
  const blocks = [];
  for (const b of Array.isArray(input.blocks) ? input.blocks.slice(0, 20) : []) {
    const from = new Date(b?.from), to = new Date(b?.to);
    if (isNaN(from) || isNaN(to) || to <= from) return { error: "A table block needs a start and a later end." };
    blocks.push({ from: from.toISOString(), to: to.toISOString(), reason: clean(b.reason, 120) || null, ...(b.fromLocal && b.toLocal ? { fromLocal: b.fromLocal, toLocal: b.toLocal } : {}) });
  }
  return { table: { label, minParty, maxParty, active: input.active !== false, blocks } };
}

export async function saveTable({ orgId, membership, actorEmail, locationId, tableId, areaId, combinableWith, ...body }) {
  if (!CAN.manage(membership)) return fail("Only a manager can change tables.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  // "2026-12-24T18:00" from the settings screen is wall-clock time at the location, not the server's time zone.
  const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
  if (Array.isArray(body.blocks)) body.blocks = body.blocks.map((b) => { const lf = b?.fromLocal || b?.from, lt = b?.toLocal || b?.to; const f = LOCAL.exec(String(lf || "")), t = LOCAL.exec(String(lt || "")); return f && t ? { ...b, from: zonedToUtc(f[1], f[2], got.location.timeZone), to: zonedToUtc(t[1], t[2], got.location.timeZone), fromLocal: lf, toLocal: lt } : b; });
  const n = normalizeTable(body);
  if (n.error) return fail(n.error);
  const { areas, tables } = await loadSeating(orgId, got.location._id);
  const area = areas.find((a) => String(a._id) === String(areaId));
  if (!area) return fail("Choose a seating area for the table.");
  if (tables.some((t) => t.label.toLowerCase() === n.table.label.toLowerCase() && String(t._id) !== String(tableId || ""))) return fail("Another table at this location already has that name.", 409);
  const combo = [...new Set((Array.isArray(combinableWith) ? combinableWith : []).map(String))].filter((x) => x !== String(tableId || ""));
  if (combo.some((x) => !tables.some((t) => String(t._id) === x))) return fail("A table can only be combined with tables at the same location.");
  const set = { ...n.table, areaId: area._id, combinableWith: combo.map((x) => toObjectId(x)), updatedAt: nowIso() };
  const c = await hcol();
  let id = oid(tableId);
  if (tableId) {
    const r = await c.updateOne({ _id: id, orgId: toObjectId(orgId), kind: KINDS.table, locationId: got.location._id, deletedAt: null }, { $set: set });
    if (!r.matchedCount) return fail("Table not found.", 404);
  } else {
    if (tables.length >= 500) return fail("A location can have at most 500 tables.");
    id = (await c.insertOne({ orgId: toObjectId(orgId), kind: KINDS.table, locationId: got.location._id, ...set, createdAt: nowIso(), deletedAt: null })).insertedId;
  }
  // Combining is mutual: keep the other side in step.
  await c.updateMany({ orgId: toObjectId(orgId), kind: KINDS.table, locationId: got.location._id, _id: { $in: set.combinableWith } }, { $addToSet: { combinableWith: id } });
  await c.updateMany({ orgId: toObjectId(orgId), kind: KINDS.table, locationId: got.location._id, _id: { $nin: [...set.combinableWith, id] }, combinableWith: id }, { $pull: { combinableWith: id } });
  await logH({ orgId, recordType: "TABLE", recordId: id, actorEmail, action: tableId ? "TABLE_UPDATED" : "TABLE_CREATED", metadata: { label: set.label, minParty: set.minParty, maxParty: set.maxParty, active: set.active, blocks: set.blocks.length } });
  return { table: publicTable({ _id: id, locationId: got.location._id, ...set }) };
}

export async function removeSeating({ orgId, membership, actorEmail, locationId, kind, id }) {
  if (!CAN.manage(membership)) return fail("Only a manager can remove seating.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const c = await hcol();
  const org = toObjectId(orgId), target = oid(id);
  if (kind === "area") {
    if (await c.countDocuments({ orgId: org, kind: KINDS.table, areaId: target, deletedAt: null })) return fail("Move or remove the tables in this area first.", 409);
  } else {
    const upcoming = await c.countDocuments({ orgId: org, kind: KINDS.reservation, tableIds: target, status: { $in: ["REQUESTED", "PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED", "SEATED"] }, end: { $gt: new Date() } });
    if (upcoming) return fail(`This table has ${upcoming} upcoming reservation${upcoming > 1 ? "s" : ""}. Move them first.`, 409);
  }
  const r = await c.updateOne({ _id: target, orgId: org, kind: kind === "area" ? KINDS.area : KINDS.table, locationId: got.location._id, deletedAt: null }, { $set: { deletedAt: nowIso() } });
  if (!r.matchedCount) return fail("Not found.", 404);
  await logH({ orgId, recordType: kind === "area" ? "AREA" : "TABLE", recordId: target, actorEmail, action: "REMOVED" });
  return { ok: true };
}

/** Stock locations a manager can link a restaurant location to. */
export async function listWarehouses({ orgId, membership }) {
  if (!CAN.manage(membership)) return fail("Only a manager can link stock locations.", 403);
  const { warehouses } = await getOrgCollections();
  const rows = await warehouses.find({ orgId: toObjectId(orgId), deletedAt: null }).project({ name: 1 }).sort({ name: 1 }).limit(200).toArray();
  return { warehouses: rows.map((w) => ({ id: String(w._id), name: w.name })) };
}
