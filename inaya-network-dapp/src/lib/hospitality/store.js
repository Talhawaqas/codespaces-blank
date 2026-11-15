// src/lib/hospitality/store.js
//
// Hospitality & Food Service Workspace: storage, roles, location scoping, audit and events.
//
// The Atlas cluster is at its collection limit, so (as with Appointments & Campaigns) nothing new is created:
// every hospitality record lives in the existing `calendar_records` collection under an `h_*` kind.
//   h_settings | h_location | h_area | h_table | h_reservation | h_lock | h_cap | h_waitlist | h_counter
//   h_menu | h_category | h_item | h_wastage | h_count | h_receiving | h_supplier_pref
//   h_shift | h_unavailable | h_checklist_tpl | h_checklist_run | h_incident
// Every document carries orgId; every query filters on { orgId, kind }. Guest marketing consent stays in
// marketing_records (engagement/suppression.js); guests are CRM contacts; ingredients are Inventory products.
//
// Roles: `hospitalityRole` on org_members (same pattern as educationRole):
//   manager : everything in the workspace for the locations they're allowed
//   host    : reservations, waitlist, guest notes
//   service : today's reservations (no private notes), seating, checklists, incidents
//   kitchen : menu drafts, recipes, wastage, checklists
//   stock   : counts, wastage, reorder, receiving
// Owner/admin manage everything in every location. Location scope: `hospitalityLocationIds` on the member; a
// member with no list sees the location only while the company has a single one (SOW 7.2: multi-location access
// must be explicit).

import { connectToDatabase } from "../mongodb.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { appendAuditEntry } from "../auditChain.js";

export const HOSPITALITY_ROLES = ["manager", "host", "service", "kitchen", "stock"];
export const KINDS = {
  settings: "h_settings", location: "h_location", area: "h_area", table: "h_table", reservation: "h_reservation", lock: "h_lock", cap: "h_cap",
  waitlist: "h_waitlist", counter: "h_counter", menu: "h_menu", category: "h_category", item: "h_item", wastage: "h_wastage", count: "h_count",
  receiving: "h_receiving", supplierPref: "h_supplier_pref", shift: "h_shift", unavailable: "h_unavailable", checklistTpl: "h_checklist_tpl",
  checklistRun: "h_checklist_run", incident: "h_incident",
};

export const fail = (error, status = 400) => ({ error, status });
export const clean = (s, max = 500) => (s === null || s === undefined ? "" : String(s).trim().slice(0, max));
export const nowIso = () => new Date().toISOString();
export const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(e));
export const oid = (id) => { try { return id ? toObjectId(id) : null; } catch { return null; } };
export const sid = (v) => (v === null || v === undefined ? null : String(v));
/** Digits-only phone for matching; display value is kept as typed. */
export const normPhone = (p) => { const d = String(p || "").replace(/[^\d+]/g, ""); return d.replace(/(?!^)\+/g, "").length >= 7 ? d.replace(/(?!^)\+/g, "") : ""; };
export const intIn = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

let indexesReady = null;
export async function hcol() {
  const { db } = await connectToDatabase();
  return db.collection("calendar_records");
}

export async function ensureHospitalityIndexes() {
  if (indexesReady) return indexesReady;
  indexesReady = (async () => {
    const c = await hcol();
    await Promise.all([
      // The two uniqueness guarantees the booking engine relies on (SOW 8.5): one reservation per table per
      // 15-minute slot, and one capacity counter per location per slot.
      c.createIndex({ orgId: 1, kind: 1, lockKey: 1 }, { unique: true, partialFilterExpression: { kind: "h_lock" }, name: "h_lock_unique" }),
      c.createIndex({ orgId: 1, kind: 1, capKey: 1 }, { unique: true, partialFilterExpression: { kind: "h_cap" }, name: "h_cap_unique" }),
      c.createIndex({ orgId: 1, kind: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { kind: "h_reservation", idempotencyKey: { $type: "string" } }, name: "h_idem_unique" }),
      c.createIndex({ kind: 1, publicSlug: 1 }, { unique: true, partialFilterExpression: { kind: "h_location", publicSlug: { $type: "string" } }, name: "h_slug_unique" }),
      c.createIndex({ orgId: 1, kind: 1, locationId: 1, start: 1 }, { name: "h_loc_start" }),
      c.createIndex({ orgId: 1, kind: 1, locationId: 1, status: 1, date: 1 }, { name: "h_loc_status_date" }),
      c.createIndex({ kind: 1, manageTokenHash: 1 }, { partialFilterExpression: { kind: "h_reservation" }, name: "h_manage_token" }),
      c.createIndex({ kind: 1, "reminder.dueAt": 1 }, { partialFilterExpression: { kind: "h_reservation" }, name: "h_reminder_due" }),
      c.createIndex({ orgId: 1, kind: 1, reservationId: 1 }, { partialFilterExpression: { kind: "h_lock" }, name: "h_lock_res" }),
      c.createIndex({ orgId: 1, kind: 1, key: 1 }, { unique: true, partialFilterExpression: { kind: "h_counter" }, name: "h_counter_unique" }),
      c.createIndex({ orgId: 1, kind: 1, runKey: 1 }, { unique: true, partialFilterExpression: { kind: "h_checklist_run" }, name: "h_run_unique" }),
    ]);
  })().catch((e) => { indexesReady = null; throw e; });
  return indexesReady;
}

// ---- roles and capabilities ----
export const hRole = (m) => (HOSPITALITY_ROLES.includes(m?.hospitalityRole) ? m.hospitalityRole : null);
export const canAccessHospitality = (m) => canManageOrg(m) || !!hRole(m);
export const canManageHospitality = (m) => canManageOrg(m) || hRole(m) === "manager";
const anyOf = (m, roles) => canManageHospitality(m) || roles.includes(hRole(m));
export const CAN = {
  manage: canManageHospitality,
  reservationsRead: (m) => anyOf(m, ["host", "service"]),
  reservationsWrite: (m) => anyOf(m, ["host"]),
  serviceUpdate: (m) => anyOf(m, ["host", "service"]),
  guestNotes: (m) => anyOf(m, ["host"]),
  guestExport: canManageHospitality,
  menuRead: canAccessHospitality,
  menuEdit: (m) => anyOf(m, ["kitchen"]),
  menuPublish: canManageHospitality,
  stockRead: (m) => anyOf(m, ["kitchen", "stock"]),
  stockWrite: (m) => anyOf(m, ["kitchen", "stock"]),
  stockApprove: canManageHospitality,
  reorder: (m) => anyOf(m, ["stock"]),
  rosterRead: canAccessHospitality,
  rosterEdit: canManageHospitality,
  checklists: canAccessHospitality,
  incidentsCreate: canAccessHospitality,
  incidentsAll: canManageHospitality,
  reports: canManageHospitality,
  integrations: canManageOrg,
};

/** Capability names the caller holds, for the UI (the server still checks every call). */
export const capabilitiesOf = (m) => Object.fromEntries(Object.entries(CAN).map(([k, f]) => [k, !!f(m)]));

// ---- location scope ----
export async function listLocationDocs(orgId) {
  const c = await hcol();
  return c.find({ orgId: toObjectId(orgId), kind: KINDS.location, deletedAt: null }).sort({ createdAt: 1 }).limit(200).toArray();
}

/** Pure: may this member act in `locationId`, given how many locations the company has? */
export function memberCanUseLocation(m, locationId, locationCount) {
  if (!canAccessHospitality(m)) return false;
  if (canManageOrg(m)) return true;
  const ids = Array.isArray(m?.hospitalityLocationIds) ? m.hospitalityLocationIds.map(String) : null;
  if (ids && ids.length) return ids.includes(String(locationId));
  return locationCount <= 1;
}

/** Locations the member may see. */
export async function allowedLocations(orgId, m) {
  const all = await listLocationDocs(orgId);
  return all.filter((l) => memberCanUseLocation(m, l._id, all.length));
}

/** Loads one location and enforces scope. Returns { location } or { error, status } (404 either way: no existence leak). */
export async function requireLocation(orgId, m, locationId) {
  const id = oid(locationId);
  if (!id) return fail("Choose a location.", 400);
  const all = await listLocationDocs(orgId);
  const location = all.find((l) => String(l._id) === String(id));
  if (!location || !memberCanUseLocation(m, id, all.length)) return fail("Location not found.", 404);
  return { location };
}

// ---- audit, workflow events, notifications ----
export async function logH({ orgId, recordType, recordId, actorEmail, action, metadata, previousState = null, newState = null }) {
  try {
    await appendAuditEntry({ orgId, recordType: `HOSPITALITY_${recordType}`, recordId: recordId ? toObjectId(recordId) : null, actorEmail: actorEmail || "system", action, previousState, newState, metadata: metadata || {} });
  } catch (err) { console.error("hospitality audit append failed:", err.message); }
}

/** Raises a workflow event (Automations "Event" trigger). Never throws; payloads carry ids and non-sensitive fields only. */
export function emitH(orgId, key, eventId, payload = {}) {
  return import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId, type: "event", key, eventId: `${key}:${eventId}`, payload: { eventType: key, ...payload } })).catch(() => {});
}

/** In-app notification to members holding one of `roles` at a location (managers always included). No guest personal data in the title/body. */
export async function notifyRoles({ orgId, locationId = null, roles = [], title, body, type, sourceId, actionUrl = "/business?view=hospitality", severity = "info" }) {
  try {
    const { orgMembers } = await getOrgCollections();
    const members = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1, role: 1, hospitalityRole: 1, hospitalityLocationIds: 1 }).limit(500).toArray();
    const count = (await listLocationDocs(orgId)).length;
    const targets = members.filter((m) => (canManageHospitality(m) || roles.includes(hRole(m))) && (!locationId || memberCanUseLocation(m, locationId, count)));
    const { createNotification } = await import("../notifications.js");
    await Promise.all(targets.map((m) => createNotification({ scope: "org", orgId, targetEmail: m.email, category: "business", severity, type, title, body, sourceModule: "hospitality", sourceId: sid(sourceId), actionUrl, dedupeKey: `hospitality:${type}:${sourceId}:${m.email}` }).catch(() => {})));
  } catch (err) { console.error("hospitality notify failed:", err.message); }
}

/** Sequential human-readable numbers per company and key (atomic $inc on a counter document). */
export async function nextNumber(orgId, key) {
  const c = await hcol();
  const r = await c.findOneAndUpdate({ orgId: toObjectId(orgId), kind: KINDS.counter, key }, { $inc: { seq: 1 }, $setOnInsert: { orgId: toObjectId(orgId), kind: KINDS.counter, key, createdAt: nowIso() } }, { upsert: true, returnDocument: "after" });
  return (r?.value ?? r)?.seq || 1;
}

// ---- staff roles screen ----
export async function listStaffRoles(orgId, m) {
  if (!canManageHospitality(m)) return fail("Only a manager can see staff roles.", 403);
  const { orgMembers } = await getOrgCollections();
  const rows = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1, name: 1, role: 1, hospitalityRole: 1, hospitalityLocationIds: 1 }).limit(500).toArray();
  return { staff: rows.map((r) => ({ email: r.email, name: r.name || null, role: r.role, hospitalityRole: hRole(r), locationIds: (r.hospitalityLocationIds || []).map(String) })) };
}

export async function setStaffRole({ orgId, membership, actorEmail, email, hospitalityRole, locationIds }) {
  if (!canManageOrg(membership)) return fail("Only the company owner or an admin can change hospitality roles.", 403);
  if (hospitalityRole !== null && hospitalityRole !== undefined && !HOSPITALITY_ROLES.includes(hospitalityRole)) return fail(`Role must be one of: ${HOSPITALITY_ROLES.join(", ")}.`);
  const all = await listLocationDocs(orgId);
  const valid = new Set(all.map((l) => String(l._id)));
  const ids = Array.isArray(locationIds) ? [...new Set(locationIds.map(String))] : null;
  if (ids && ids.some((x) => !valid.has(x))) return fail("One of those locations doesn't belong to this company.");
  const set = {}, unset = {};
  if (hospitalityRole === null) unset.hospitalityRole = ""; else if (hospitalityRole) set.hospitalityRole = hospitalityRole;
  if (ids) { if (ids.length) set.hospitalityLocationIds = ids; else unset.hospitalityLocationIds = ""; }
  if (!Object.keys(set).length && !Object.keys(unset).length) return fail("Nothing to change.");
  const { orgMembers } = await getOrgCollections();
  const r = await orgMembers.updateOne({ orgId: toObjectId(orgId), email: normEmail(email), status: "active" }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  if (!r.matchedCount) return fail("That person isn't a member of this company.", 404);
  await logH({ orgId, recordType: "ROLE", recordId: null, actorEmail, action: "ROLE_CHANGED", metadata: { email: normEmail(email), hospitalityRole: hospitalityRole ?? undefined, locationIds: ids ?? undefined } });
  return { ok: true };
}
