// src/lib/ops/core.js -- Manage Orders SOW (INAYA-BOS-WO-RO-TECH-OPS-SOW-2026-V1): shared storage, entitlement, roles,
// branch scoping, numbering, audit and notifications for Work Orders, Repair Orders, the technician scheduler, job
// activity, exceptions and cheques.
//
// Storage: production is at its collection limit, so every record lives in the existing `calendar_records` collection
// under `ops_*` kinds (the same pattern as Commerce `c_*` and Workforce `w_*`). Every document carries orgId and every
// query filters { orgId, kind }.
//
// Entitlement (owner decision 25 Nov 2026): Business and Enterprise plans only, behind FEATURE_MANAGE_ORDERS.
//   * An Inaya admin can switch it on for one company in the License Manager (that explicit grant is how the founder's
//     own company runs the live acceptance tests before release).
//   * Platform release = env FEATURE_MANAGE_ORDERS=on, which still only reaches Business and Enterprise companies.
//   * env FEATURE_MANAGE_ORDERS=off is a kill switch for everyone.
// Roles: `opsRole` on org_members: manager | dispatcher | advisor | technician | storekeeper. Owners/admins are managers.
// Branch scoping reuses workforce/scope.js (members limited to their assigned branches, enforced on the server).
import { ObjectId } from "mongodb";
import { getOrgCollections, canManageOrg } from "../orgs.js";
import { canAccessFinance, canManageFinance } from "../orgGates.js";
import { envFlag } from "../featureFlags.js";
import { ccol, oid, sid, clean, fail, nowIso, audit as baseAudit } from "../commerce/store.js";
import { memberLocations, allowedLocation, scopeFilter, denyLocation } from "../workforce/scope.js";

export { ccol, oid, sid, clean, fail, nowIso, memberLocations, allowedLocation, scopeFilter, denyLocation };
export const FEATURE = "FEATURE_MANAGE_ORDERS";
export const PLANS = ["business", "enterprise"];
export const OPS_ROLES = ["manager", "dispatcher", "advisor", "technician", "storekeeper"];
export const K = {
  job: "ops_job", asset: "ops_asset", estimate: "ops_estimate", act: "ops_act", tech: "ops_tech", site: "ops_site", exc: "ops_exc",
  pm: "ops_pm", file: "ops_file", settings: "ops_settings", counter: "ops_counter",
  chqBook: "ops_chqbook", chqTpl: "ops_chqtpl", chq: "ops_chq", push: "ops_push", pushSent: "ops_push_sent",
};
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const DEFAULT_SETTINGS = {
  noJobStartMinutes: 30, // clocked in but no job started
  pausedTooLongMinutes: 120,
  notAcknowledgedMinutes: 60, // scheduled job not acknowledged/started after its start time
  labourVariancePct: 50, // actual vs estimated labour
  manualCorrectionsPerWeek: 3,
  siteRadiusMeters: 300,
  locationCapture: "off", // off | optional | required  (event-based only, at job start/finish)
  requireInspection: true,
  chequeSegregation: true, // the person who creates a cheque cannot approve it
};

// ------------------------------------------------------------------ entitlement + roles
/** Pure: is Manage Orders on for this org document? (also used by the session route to show the menu entry) */
export function entitledFromOrg(org, env = process.env) {
  const e = envFlag(FEATURE, env);
  if (e === "off" || !org) return false;
  if (org.features?.[FEATURE] === true) return true; // explicit grant by Inaya (License Manager)
  if (org.features?.[FEATURE] === false) return false;
  return e === "on" && PLANS.includes(String(org.plan || "").toLowerCase());
}
export async function opsEntitled(orgId) {
  if (envFlag(FEATURE) === "off") return false;
  const { orgs } = await getOrgCollections();
  return entitledFromOrg(await orgs.findOne({ _id: oid(orgId) }, { projection: { features: 1, plan: 1 } }));
}
export const isOwnerAdmin = (m) => canManageOrg(m);
export function opsRoleOf(m) { if (!m) return null; if (canManageOrg(m)) return "manager"; return OPS_ROLES.includes(m.opsRole) ? m.opsRole : null; }

const CAN = {
  view_all: ["manager", "dispatcher", "advisor", "storekeeper"],
  create_wo: ["manager"],
  create_ro: ["manager", "advisor"],
  edit_job: ["manager", "advisor"],
  schedule: ["manager", "dispatcher"],
  approve: ["manager"],
  parts: ["manager", "storekeeper"],
  estimate: ["manager", "advisor"],
  costs: ["manager", "advisor"],
  exceptions: ["manager"],
  settings: ["manager"],
  work: ["technician", "manager"],
};
export function can(m, action) { const r = opsRoleOf(m); return !!r && (CAN[action] || []).includes(r); }

/** Gate for every Manage Orders call. need: an action from CAN, or "any" (any ops role), or "finance" (cheques). */
export async function opsAccess({ orgId, membership, need = "any" }) {
  if (!membership) return fail("Sign in to continue.", 401);
  if (!(await opsEntitled(orgId))) return fail("Manage Orders isn't enabled for this company. It is part of the Business and Enterprise plans.", 403, "NOT_ENTITLED");
  if (need === "finance") return canAccessFinance(membership) || canManageOrg(membership) ? null : fail("Cheques need finance access.", 403, "FINANCE_ONLY");
  if (need === "finance_manage") return canManageFinance(membership) || canManageOrg(membership) ? null : fail("Only a finance manager can do this.", 403, "FINANCE_MANAGER_ONLY");
  if (need === "any") return opsRoleOf(membership) || canAccessFinance(membership) ? null : fail("You don't have a Manage Orders role. Ask an admin to give you one.", 403, "NO_OPS_ROLE");
  return can(membership, need) ? null : fail("Your role can't do this.", 403, "OPS_ROLE");
}

export async function getOpsSettings(orgId) { const c = await ccol(); const s = await c.findOne({ orgId: oid(orgId), kind: K.settings }); return { ...DEFAULT_SETTINGS, ...(s?.settings || {}) }; }
export async function setOpsSettings({ orgId, membership, actorEmail, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "settings" }); if (d) return d;
  const cur = await getOpsSettings(orgId); const next = { ...cur };
  for (const k of ["noJobStartMinutes", "pausedTooLongMinutes", "notAcknowledgedMinutes", "labourVariancePct", "manualCorrectionsPerWeek", "siteRadiusMeters"]) if (input[k] !== undefined) {
    const n = Number(input[k]); if (!Number.isInteger(n) || n < 1 || n > 100000) return fail(`${k} must be a whole number from 1 to 100000.`); next[k] = n;
  }
  if (input.locationCapture !== undefined) { if (!["off", "optional", "required"].includes(input.locationCapture)) return fail("locationCapture must be off, optional or required."); next.locationCapture = input.locationCapture; }
  for (const k of ["requireInspection", "chequeSegregation"]) if (input[k] !== undefined) next[k] = !!input[k];
  const c = await ccol();
  await c.updateOne({ orgId: oid(orgId), kind: K.settings }, { $set: { settings: next, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { orgId: oid(orgId), kind: K.settings, createdAt: nowIso() } }, { upsert: true });
  await audit({ orgId, actorEmail, recordType: "OPS_SETTINGS", recordId: orgId, action: "OPS_SETTINGS_UPDATED", previousState: null, newState: null, metadata: next });
  return { settings: next };
}

// ------------------------------------------------------------------ helpers
export async function nextRef(orgId, prefix, session = null) {
  const c = await ccol();
  const r = await c.findOneAndUpdate({ orgId: oid(orgId), kind: K.counter, key: prefix }, { $inc: { value: 1 }, $setOnInsert: { orgId: oid(orgId), kind: K.counter, key: prefix } }, { upsert: true, returnDocument: "after", session });
  return `${prefix}-${String(r.value).padStart(5, "0")}`;
}
/** Audit (existing org activity log) + the matching integration event. Events carry only the action and states. */
export async function audit(a) {
  await baseAudit(a);
  const kind = { WORK_ORDER: "work_order", REPAIR_ORDER: "repair_order", CHEQUE: "cheque" }[a.recordType]; if (!kind) return;
  let type = null;
  if (a.action === "WO_CREATED" || a.action === "RO_CREATED") type = `${kind}.created`;
  else if (a.action === "OPS_TECHNICIAN_ASSIGNED") type = "job.assigned";
  else if (String(a.action).startsWith("OPS_JOB_")) type = "job.activity";
  else if (a.newState && a.newState !== a.previousState) type = kind === "cheque" ? "cheque.status_changed" : `${kind}.status_changed`;
  if (type) await emitOps({ orgId: a.orgId, type, entityId: a.recordId, data: { action: a.action, previousState: a.previousState ?? null, newState: a.newState ?? null, number: a.metadata?.number ?? null } });
}
const prefEvent = (type) => (/^ops_(exception|parts_request|submitted|flag|explain)/.test(type || "") ? "ops.review" : /^ops_cheque/.test(type || "") ? "ops.cheques" : "ops.jobs");
export async function notifyMember({ orgId, email, title, body, type, sourceId, dedupeKey, severity = "info", jobId = null }) {
  // Each person's notification preferences (existing notify router) decide in-app and push delivery.
  let ch = { inApp: true, push: true };
  if (email) { try { const { getPrefs } = await import("../notify/router.js"); const p = await getPrefs({ orgId: sid(orgId), email }); ch = p.prefs?.[prefEvent(type)] || ch; } catch { /* defaults */ } }
  if (ch.inApp !== false) try {
    const { createNotification } = await import("../notifications.js");
    // Titles/bodies never carry customer personal data (they can show on a lock screen).
    await createNotification({ scope: "org", orgId: sid(orgId), targetEmail: email || null, category: "business", severity, type, title: clean(title, 140), body: clean(body, 300), sourceModule: "manage-orders", sourceId: sid(sourceId), actionUrl: "/business?view=manageOrders", dedupeKey });
  } catch (e) { console.error("ops notify failed:", e?.message); }
  if (email && ch.push !== false) await sendPush({ orgId, email, title, body, data: { orgId: sid(orgId), jobId: jobId ? sid(jobId) : /^ops_(exception|explain|cheque)/.test(type || "") ? null : sid(sourceId), type }, dedupeKey }).catch((e) => console.error("ops push failed:", e?.message));
}

// ------------------------------------------------------------------ lock-screen push (Expo push service -> FCM / APNs)
// A device token is stored per (company, person, device) in kind ops_push. Pushes carry only the short title/body above
// (job number + what happened) and ids for opening the job; never customer names, addresses or amounts.
const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/;
let pushTransport = null; // tests inject a fake transport
export function __setPushTransport(fn) { pushTransport = fn; }
export async function registerPushToken({ orgId, membership, token, platform, unregister = false }) {
  if (!membership?.email) return fail("Sign in to continue.", 401);
  if (!(await opsEntitled(orgId))) return fail("Manage Orders isn't enabled for this company.", 403, "NOT_ENTITLED");
  const t = String(token || "").trim(); if (!EXPO_TOKEN.test(t)) return fail("Invalid device token.");
  const c = await ccol(); const key = `push:${t}`;
  if (unregister) { await c.deleteOne({ orgId: oid(orgId), kind: K.push, opsKey: key, email: membership.email }); return { ok: true, registered: false }; }
  const now = nowIso();
  await c.updateOne({ orgId: oid(orgId), opsKey: key }, { $set: { kind: K.push, opsDoc: true, email: membership.email, token: t, platform: ["android", "ios"].includes(platform) ? platform : "android", lastSeenAt: now }, $setOnInsert: { orgId: oid(orgId), createdAt: now } }, { upsert: true });
  return { ok: true, registered: true };
}
export async function sendPush({ orgId, email, title, body, data = {}, dedupeKey = null }) {
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: K.push, email }).limit(10).toArray(); if (!rows.length) return { sent: 0 };
  if (dedupeKey) { const r = await c.updateOne({ orgId: oid(orgId), opsKey: `pushsent:${dedupeKey}:${email}` }, { $setOnInsert: { orgId: oid(orgId), kind: K.pushSent, opsDoc: true, at: nowIso() } }, { upsert: true }); if (!r.upsertedCount) return { sent: 0, duplicate: true }; }
  const messages = rows.map((r) => ({ to: r.token, title: clean(title, 80), body: clean(body, 120), data, sound: "default", channelId: "jobs", priority: "high" }));
  const send = pushTransport || (async (msgs) => { const res = await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(msgs) }); return res.json(); });
  const out = await send(messages);
  const tickets = Array.isArray(out?.data) ? out.data : [];
  for (let i = 0; i < tickets.length; i++) if (tickets[i]?.status === "error" && tickets[i]?.details?.error === "DeviceNotRegistered") await c.deleteOne({ orgId: oid(orgId), kind: K.push, token: rows[i].token });
  return { sent: tickets.filter((t) => t?.status === "ok").length };
}

// ------------------------------------------------------------------ integration events (existing signed webhook registry)
/** PII-minimised event for the company's own webhooks (ids, numbers, states; no customer details). Never blocks. */
export async function emitOps({ orgId, type, entityId, data = {}, eventId = null }) {
  try { const { emitWebhookEvent } = await import("../webhooks/registry.js"); await emitWebhookEvent({ orgId: sid(orgId), type, eventId, data: { version: 1, entityId: sid(entityId), occurredAt: nowIso(), ...data } }); }
  catch (e) { console.error("ops event not queued:", type, e?.message); }
}
export async function membersByEmail(orgId, emails) {
  const { orgMembers } = await getOrgCollections();
  const list = await orgMembers.find({ orgId: oid(orgId), email: { $in: [...new Set(emails.filter(Boolean))] }, status: { $ne: "removed" } }).toArray();
  return new Map(list.map((m) => [m.email, m]));
}
export async function branchName(orgId, warehouseId) {
  const { warehouses } = await getOrgCollections();
  const w = await warehouses.findOne({ _id: oid(warehouseId), orgId: oid(orgId) }, { projection: { name: 1 } });
  return w?.name || null;
}
export const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
export const isDate = (v) => !v || !Number.isNaN(new Date(v).getTime());
export const iso = (v) => (v ? new Date(v).toISOString() : null);
export const newId = () => new ObjectId();
