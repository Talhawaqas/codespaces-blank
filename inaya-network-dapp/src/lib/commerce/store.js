// src/lib/commerce/store.js -- Inaya Commerce (Master SOW, Initiative A/F): shared storage, roles, entitlement, settings,
// audit and events for the commerce layer.
//
// Storage: the production MongoDB cluster is at its collection limit (owner decision 21 Nov 2026: reuse collections), so
// commerce CONFIGURATION lives in the existing `calendar_records` collection under `c_*` kinds, exactly like Hospitality's
// `h_*` kinds. Every document carries orgId and every query filters { orgId, kind }:
//   c_settings      one per company: currency, tax mode, rounding, discount limits, return policy, receipt footer
//   c_tax_category  named tax category (e.g. "Standard", "Zero-rated", "Exempt") with a default rate
//   c_tax_rate      a rate for a category at a location (warehouse) -- location-specific overrides
//   c_price_list    a named price list (retail/wholesale/...) and its currency
//   c_price         one product price in a price list            (unique per list+product)
//   c_cust_price    one customer-specific product price           (unique per customer+product)
//   c_register      a till/register at a location
//   c_shift         a register shift (one OPEN shift per register)
//   c_cash_move     cash in / cash out during a shift
//   c_counter       per-company sequence counters (receipt numbers)
// Sales themselves are TRANSACTIONS and live in `sales_orders` (channel "POS"), sharing the order lifecycle with Online
// Commerce as the Master SOW asks; products stay the single catalogue (`products`).
//
// Roles: `commerceRole` on org_members -- "manager" (configure, approve, refunds, reports), "supervisor" (approve
// discounts/voids up to the supervisor limit, cash moves), "cashier" (sell). Owners and admins are always managers.
// Entitlement: FEATURE_COMMERCE (a paid add-on for Business/Enterprise; enabled by Inaya, never self-service), checked
// server-side on every commerce API, plus the License Manager gate that already applies to every company route.
import { randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { connectToDatabase } from "../mongodb.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { logOrgActivity } from "../org-activity-log.js";
import { isSupportedCurrency } from "../currency.js";

export const KINDS = { settings: "c_settings", taxCategory: "c_tax_category", taxRate: "c_tax_rate", priceList: "c_price_list", price: "c_price", custPrice: "c_cust_price", register: "c_register", shift: "c_shift", cashMove: "c_cash_move", counter: "c_counter" };
export const COMMERCE_ROLES = ["manager", "supervisor", "cashier"];
export const COMMERCE_FEATURE = "FEATURE_COMMERCE";

export const fail = (error, status = 400, code) => ({ error, status, ...(code ? { code } : {}) });
export const clean = (s, max = 300) => (s === null || s === undefined ? "" : String(s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max));
export const nowIso = () => new Date().toISOString();
export const oid = (id) => { try { return id ? toObjectId(id) : null; } catch { return null; } };
export const sid = (v) => (v === null || v === undefined ? null : String(v));
/** Money in minor units (cents/paisa) to avoid floating-point drift; all commerce maths is done on integers. */
export const toMinor = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
export const fromMinor = (m) => Math.round(m) / 100;
export const correlationId = () => `cor_${randomBytes(8).toString("hex")}`;

let indexesReady = null;
export async function ccol() { const { db } = await connectToDatabase(); return db.collection("calendar_records"); }
export async function ensureCommerceIndexes() {
  if (indexesReady) return indexesReady;
  indexesReady = (async () => {
    const c = await ccol();
    await Promise.all([
      c.createIndex({ orgId: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: KINDS.settings }, name: "c_settings_unique" }),
      c.createIndex({ orgId: 1, kind: 1, priceListId: 1, productId: 1 }, { unique: true, partialFilterExpression: { kind: KINDS.price }, name: "c_price_unique" }),
      c.createIndex({ orgId: 1, kind: 1, customerId: 1, productId: 1 }, { unique: true, partialFilterExpression: { kind: KINDS.custPrice }, name: "c_cust_price_unique" }),
      c.createIndex({ orgId: 1, kind: 1, categoryId: 1, warehouseId: 1 }, { unique: true, partialFilterExpression: { kind: KINDS.taxRate }, name: "c_tax_rate_unique" }),
      c.createIndex({ orgId: 1, kind: 1, code: 1 }, { unique: true, partialFilterExpression: { kind: { $in: [KINDS.register, KINDS.priceList, KINDS.taxCategory] } }, name: "c_code_unique" }),
      c.createIndex({ orgId: 1, kind: 1, registerId: 1 }, { unique: true, partialFilterExpression: { kind: KINDS.shift, status: "OPEN" }, name: "c_open_shift_unique" }),
      c.createIndex({ orgId: 1, kind: 1, key: 1 }, { unique: true, partialFilterExpression: { kind: KINDS.counter }, name: "c_counter_unique" }),
      c.createIndex({ orgId: 1, kind: 1, shiftId: 1 }, { partialFilterExpression: { kind: KINDS.cashMove }, name: "c_cash_shift" }),
      // Phase 4: loyalty points ledger, gift-card movements and promotion uses are idempotent; card codes are looked up by hash
      c.createIndex({ orgId: 1, kind: 1, idem: 1 }, { unique: true, partialFilterExpression: { kind: { $in: ["g_points", "g_card_tx", "g_promo_use"] } }, name: "g_idem_unique" }),
      c.createIndex({ orgId: 1, kind: 1, codeHash: 1 }, { unique: true, partialFilterExpression: { kind: "g_card" }, name: "g_card_code" }),
      c.createIndex({ orgId: 1, kind: 1, customerId: 1 }, { partialFilterExpression: { kind: { $in: ["g_points", "g_card", "g_member"] } }, name: "g_customer" }),
    ]);
  })().catch((e) => { indexesReady = null; throw e; });
  return indexesReady;
}

// ---------------------------------------------------------------- roles and entitlement
const isOwnerAdmin = (m) => canManageOrg(m);
export const commerceRoleOf = (m) => (isOwnerAdmin(m) ? "manager" : COMMERCE_ROLES.includes(m?.commerceRole) ? m.commerceRole : null);
export const canSell = (m) => !!commerceRoleOf(m);
export const canSupervise = (m) => ["manager", "supervisor"].includes(commerceRoleOf(m));
export const canManageCommerce = (m) => commerceRoleOf(m) === "manager";

/** Server-side entitlement + role gate for every commerce API. */
export async function commerceAccess({ orgId, membership, need = "sell" }) {
  if (!(await isFeatureEnabled(COMMERCE_FEATURE, orgId))) return fail("Inaya Commerce is not enabled for this company. It is available as an add-on to the Business and Enterprise plans.", 403, "COMMERCE_NOT_ENABLED");
  const ok = need === "manage" ? canManageCommerce(membership) : need === "supervise" ? canSupervise(membership) : canSell(membership);
  if (!ok) return fail(need === "manage" ? "Only a commerce manager (or the owner/admin) can do that." : need === "supervise" ? "This needs a supervisor or manager." : "You don't have a commerce role in this company.", 403, "COMMERCE_ROLE");
  return null;
}

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = {
  currency: "PKR", taxMode: "exclusive", // "exclusive" | "inclusive" -- how shelf prices are entered
  rounding: { mode: "line", cashIncrement: 0 }, // per-line tax rounding; optional cash rounding (e.g. 100 = 1.00) for cash tenders
  discountLimits: { cashierPercent: 10, supervisorPercent: 30 }, // above supervisor -> manager approval
  allowPriceOverride: "supervisor", // who may override a price: "never" | "supervisor" | "manager"
  stacking: "line_and_order", // "line_and_order" | "best_only"
  returnPolicy: { days: 30, requireReceipt: true, text: "Returns accepted within 30 days with a receipt." },
  receiptFooter: "", allowNegativeStock: false,
  refundRole: "supervisor", // lowest commerce role that may refund without approval: "cashier" | "supervisor" | "manager"
  quarantineWarehouseId: null, // where QUARANTINE returns go (a location kept out of selling)
  cashVarianceTolerance: 0, // minor units; a shift closing further over/short than this is flagged for the manager
  timezone: "UTC", // IANA zone used to put sales on the right day/hour in reports (e.g. "Asia/Karachi", "Europe/London")
  receiptShowNotes: false, // print sale notes on receipts (privacy: off by default)
};
export async function getSettings(orgId) {
  await ensureCommerceIndexes();
  const c = await ccol();
  const s = await c.findOne({ orgId: oid(orgId), kind: KINDS.settings });
  return { ...DEFAULT_SETTINGS, ...(s?.settings || {}), discountLimits: { ...DEFAULT_SETTINGS.discountLimits, ...(s?.settings?.discountLimits || {}) }, rounding: { ...DEFAULT_SETTINGS.rounding, ...(s?.settings?.rounding || {}) }, returnPolicy: { ...DEFAULT_SETTINGS.returnPolicy, ...(s?.settings?.returnPolicy || {}) } };
}
export function validateSettings(input = {}) {
  const out = {};
  if (input.currency !== undefined) { if (!isSupportedCurrency(input.currency)) return fail("Unsupported currency."); out.currency = input.currency; }
  if (input.taxMode !== undefined) { if (!["inclusive", "exclusive"].includes(input.taxMode)) return fail("taxMode must be inclusive or exclusive."); out.taxMode = input.taxMode; }
  if (input.rounding !== undefined) {
    const mode = input.rounding.mode ?? "line"; const inc = Number(input.rounding.cashIncrement ?? 0);
    if (!["line", "total"].includes(mode) || !Number.isInteger(inc) || inc < 0 || inc > 10000) return fail("Rounding: mode line|total, cashIncrement a whole number of minor units (0-10000).");
    out.rounding = { mode, cashIncrement: inc };
  }
  if (input.discountLimits !== undefined) {
    const c = Number(input.discountLimits.cashierPercent); const s = Number(input.discountLimits.supervisorPercent);
    if (!(c >= 0 && c <= 100 && s >= c && s <= 100)) return fail("Discount limits: 0 <= cashier <= supervisor <= 100.");
    out.discountLimits = { cashierPercent: c, supervisorPercent: s };
  }
  if (input.allowPriceOverride !== undefined) { if (!["never", "supervisor", "manager"].includes(input.allowPriceOverride)) return fail("allowPriceOverride: never|supervisor|manager."); out.allowPriceOverride = input.allowPriceOverride; }
  if (input.stacking !== undefined) { if (!["line_and_order", "best_only"].includes(input.stacking)) return fail("stacking: line_and_order|best_only."); out.stacking = input.stacking; }
  if (input.returnPolicy !== undefined) {
    const d = Number(input.returnPolicy.days); if (!Number.isInteger(d) || d < 0 || d > 3650) return fail("Return days 0-3650.");
    out.returnPolicy = { days: d, requireReceipt: input.returnPolicy.requireReceipt !== false, text: clean(input.returnPolicy.text, 500) };
  }
  if (input.receiptFooter !== undefined) out.receiptFooter = clean(input.receiptFooter, 500);
  if (input.allowNegativeStock !== undefined) out.allowNegativeStock = input.allowNegativeStock === true;
  if (input.refundRole !== undefined) { if (!COMMERCE_ROLES.includes(input.refundRole)) return fail("refundRole: cashier|supervisor|manager."); out.refundRole = input.refundRole; }
  if (input.quarantineWarehouseId !== undefined) out.quarantineWarehouseId = input.quarantineWarehouseId ? sid(input.quarantineWarehouseId) : null;
  if (input.timezone !== undefined) { try { new Intl.DateTimeFormat("en", { timeZone: String(input.timezone) }); out.timezone = String(input.timezone); } catch { return fail("Unknown time zone (use a name like Asia/Karachi or Europe/London)."); } }
  if (input.receiptShowNotes !== undefined) out.receiptShowNotes = input.receiptShowNotes === true;
  if (input.cashVarianceTolerance !== undefined) { const t = Number(input.cashVarianceTolerance); if (!Number.isInteger(t) || t < 0 || t > 10000000) return fail("cashVarianceTolerance: whole minor units >= 0."); out.cashVarianceTolerance = t; }
  return { settings: out };
}
export async function updateSettings({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const v = validateSettings(input); if (v.error) return v;
  if (v.settings.quarantineWarehouseId) { const { warehouses } = await getOrgCollections(); if (!(await warehouses.findOne({ _id: oid(v.settings.quarantineWarehouseId), orgId: oid(orgId) }))) return fail("Quarantine location not found.", 404); }
  const before = await getSettings(orgId); const c = await ccol(); const now = nowIso();
  const set = Object.fromEntries(Object.entries(v.settings).map(([k, val]) => [`settings.${k}`, val]));
  await c.updateOne({ orgId: oid(orgId), kind: KINDS.settings }, { $set: { ...set, updatedAt: now, updatedBy: actorEmail }, $setOnInsert: { orgId: oid(orgId), kind: KINDS.settings, createdAt: now } }, { upsert: true });
  await audit({ orgId, actorEmail, recordType: "COMMERCE_SETTINGS", recordId: orgId, action: "SETTINGS_CHANGED", previousState: before, newState: v.settings });
  return { settings: await getSettings(orgId) };
}

// ---------------------------------------------------------------- counters, audit, events
/** Atomic per-company sequence (receipt numbers etc.). Inside a transaction when a session is passed. */
export async function nextNumber(orgId, key, session = null) {
  const c = await ccol();
  const r = await c.findOneAndUpdate({ orgId: oid(orgId), kind: KINDS.counter, key }, { $inc: { value: 1 }, $setOnInsert: { orgId: oid(orgId), kind: KINDS.counter, key } }, { upsert: true, returnDocument: "after", session });
  return r.value;
}
export async function audit({ orgId, actorEmail, recordType, recordId, action, previousState = null, newState = null, metadata = {} }) {
  try { await logOrgActivity({ orgId: oid(orgId), recordType, recordId: oid(recordId) || oid(orgId), actorEmail: actorEmail || "system", action, previousState, newState, metadata }); } catch (e) { console.error("commerce audit failed:", e?.message); }
}
/** Commerce event contract (Master SOW 5.3): name + version, tenant, entity, actor/source, timestamp, correlation and
 *  idempotency ids, a PII-minimised payload. Delivered through the existing signed webhook registry (retries, dead
 *  letters, delivery status). An event is a notification, never proof that downstream work completed. */
export const EVENT_VERSION = 1;
export async function emitCommerceEvent({ orgId, name, entityId, actorEmail, source = "pos", correlationId: cid, idempotencyKey, payload = {} }) {
  try {
    const { emitWebhookEvent } = await import("../webhooks/registry.js");
    await emitWebhookEvent({ orgId: sid(orgId), type: name, eventId: idempotencyKey ? `${name}:${idempotencyKey}` : null, data: { version: EVENT_VERSION, entityId: sid(entityId), actor: actorEmail || null, source, occurredAt: nowIso(), correlationId: cid || null, idempotencyKey: idempotencyKey || null, ...payload } });
  } catch (e) { console.error("commerce event not queued:", name, e?.message); }
}
export async function membersCol() { const { orgMembers } = await getOrgCollections(); return orgMembers; }

// ---------------------------------------------------------------- staff roles
export async function listCommerceStaff({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const m = await membersCol();
  const rows = await m.find({ orgId: oid(orgId), status: "active" }, { projection: { email: 1, role: 1, commerceRole: 1 } }).toArray();
  return { staff: rows.map((r) => ({ email: r.email, orgRole: r.role, commerceRole: commerceRoleOf(r) })) };
}
/** Owner/admin or a commerce manager sets a member's commerce role (null removes it). Owners/admins are always managers. */
export async function setCommerceRole({ orgId, membership, actorEmail, email, commerceRole }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  if (commerceRole !== null && !COMMERCE_ROLES.includes(commerceRole)) return fail("commerceRole must be manager, supervisor, cashier or null.");
  const m = await membersCol(); const target = await m.findOne({ orgId: oid(orgId), email: String(email || "").trim().toLowerCase(), status: "active" });
  if (!target) return fail("That person is not an active member of this company.", 404);
  if (canManageOrg(target)) return fail("Owners and admins are always commerce managers.", 409);
  await m.updateOne({ _id: target._id }, commerceRole ? { $set: { commerceRole } } : { $unset: { commerceRole: "" } });
  await audit({ orgId, actorEmail, recordType: "COMMERCE_ROLE", recordId: target._id, action: "COMMERCE_ROLE_CHANGED", previousState: { commerceRole: target.commerceRole || null }, newState: { commerceRole } });
  return { email: target.email, commerceRole };
}
