// src/lib/connect/core.js -- Inaya Connect (SOW INAYA-CONNECT-SOW-2026-01): shared storage, entitlement, access, settings,
// audit and helpers for the WhatsApp Business & AI Gateway.
//
// Storage: production is at its collection limit, so records live in `calendar_records` under `wa_*` kinds (same pattern
// as Manage Orders `ops_*`). Uniqueness reuses the generic per-company `opsKey` index; tenant routing by WhatsApp
// phone-number ID uses one global unique index on `waKey` (the only lookup that runs before the company is known).
// Entitlement: Business + Enterprise behind FEATURE_INAYA_CONNECT; an explicit per-company grant (License Manager) is
// how the founder company runs the live tests before release; env FEATURE_INAYA_CONNECT=off is a kill switch.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getOrgCollections, canManageOrg } from "../orgs.js";
import { envFlag } from "../featureFlags.js";
import { ccol, oid, sid, clean, fail, nowIso, audit as baseAudit } from "../commerce/store.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";

export { ccol, oid, sid, clean, fail, nowIso, encryptIntegrationSecret, isIntegrationCryptoConfigured };
export const FEATURE = "FEATURE_INAYA_CONNECT";
export const PLANS = ["business", "enterprise"];
export const K = {
  conn: "wa_conn", msg: "wa_msg", conv: "wa_conv", contact: "wa_contact", otp: "wa_otp", doc: "wa_doc", rule: "wa_rule",
  usage: "wa_usage", event: "wa_event", settings: "wa_settings", link: "wa_link",
};
export const DEFAULT_SETTINGS = {
  businessAssistant: true,            // staff linked to their Business OS account can ask about the business
  customerAssistant: false,           // external customers (verified) can ask about their own records
  documentIntake: true,               // suppliers/staff can send bills, receipts and other documents
  greeting: "Hello! You're messaging {company}. How can we help?",
  afterHours: "Thanks for your message. We're closed right now and will reply during business hours.",
  hours: { timezone: "Asia/Karachi", weekly: { 1: [["09:00", "18:00"]], 2: [["09:00", "18:00"]], 3: [["09:00", "18:00"]], 4: [["09:00", "18:00"]], 5: [["09:00", "18:00"]], 6: [["10:00", "16:00"]] }, alwaysOpen: false },
  limits: { monthlyOutbound: 2000, perSenderPerHour: 30, maxMediaBytes: 10 * 1024 * 1024 },
  pricing: { currency: "USD", perMessageEstimate: 0 }, // admin enters their Meta rate; Inaya shows an estimate only
  allowedSupplierNumbers: [],          // numbers (digits) allowed to submit documents without being staff/customers
  bookkeeperSourceId: null,            // AI Bookkeeper source that receives bills/receipts (created on first use)
};

// ------------------------------------------------------------------ entitlement + access
export function entitledFromOrg(org, env = process.env) {
  const e = envFlag(FEATURE, env);
  if (e === "off" || !org) return false;
  if (org.features?.[FEATURE] === true) return true;
  if (org.features?.[FEATURE] === false) return false;
  if (e === "on" && org.plan === "professional" && org.addOns?.connect === true) return true; // Professional add-on (src/lib/addOns.js)
  return e === "on" && PLANS.includes(String(org.plan || "").toLowerCase());
}
export async function connectEntitled(orgId) {
  if (envFlag(FEATURE) === "off") return false;
  const { orgs } = await getOrgCollections();
  return entitledFromOrg(await orgs.findOne({ _id: oid(orgId) }, { projection: { features: 1, plan: 1, addOns: 1 } }));
}
/** need: "admin" (owner/admin: connect, settings, rules) | "agent" (inbox: owner/admin or supportRole) | "member" */
export async function connectAccess({ orgId, membership, need = "member" }) {
  if (!membership) return fail("Sign in to continue.", 401);
  if (!(await connectEntitled(orgId))) return fail("Inaya Connect isn't enabled for this company. It is part of the Business and Enterprise plans, or an add-on for Professional.", 403, "NOT_ENTITLED");
  if (need === "admin" && !canManageOrg(membership)) return fail("Only an owner or admin can change Inaya Connect.", 403);
  if (need === "agent" && !canManageOrg(membership) && !["agent", "manager"].includes(membership.supportRole)) return fail("You need a support role to use the WhatsApp inbox.", 403);
  return null;
}

// ------------------------------------------------------------------ settings
export async function getSettings(orgId) { const c = await ccol(); const s = await c.findOne({ orgId: oid(orgId), kind: K.settings }); return { ...DEFAULT_SETTINGS, ...(s?.settings || {}) }; }
export async function saveSettings({ orgId, membership, actorEmail, input = {} }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  const cur = await getSettings(orgId); const next = { ...cur };
  for (const k of ["businessAssistant", "customerAssistant", "documentIntake"]) if (input[k] !== undefined) next[k] = !!input[k];
  for (const k of ["greeting", "afterHours"]) if (input[k] !== undefined) next[k] = clean(input[k], 500);
  if (input.hours) {
    const h = input.hours; const tz = clean(h.timezone || cur.hours.timezone, 60);
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return fail("Unknown timezone."); }
    const weekly = {};
    for (const [day, spans] of Object.entries(h.weekly || cur.hours.weekly)) {
      if (!/^[0-6]$/.test(day) || !Array.isArray(spans)) return fail("Hours need days 0-6.");
      weekly[day] = spans.filter((s) => Array.isArray(s) && /^\d\d:\d\d$/.test(s[0]) && /^\d\d:\d\d$/.test(s[1]) && s[0] < s[1]).slice(0, 4);
    }
    next.hours = { timezone: tz, weekly, alwaysOpen: !!h.alwaysOpen };
  }
  if (input.limits) {
    const l = { ...cur.limits };
    for (const [k, lo, hi] of [["monthlyOutbound", 1, 1000000], ["perSenderPerHour", 1, 1000], ["maxMediaBytes", 1024, 16 * 1024 * 1024]]) if (input.limits[k] !== undefined) { const n = Number(input.limits[k]); if (!(Number.isInteger(n) && n >= lo && n <= hi)) return fail(`${k} must be ${lo}–${hi}.`); l[k] = n; }
    next.limits = l;
  }
  if (input.pricing) { const p = Number(input.pricing.perMessageEstimate); if (!(p >= 0 && p < 10)) return fail("Per-message estimate must be 0–10."); next.pricing = { currency: clean(input.pricing.currency || "USD", 3).toUpperCase(), perMessageEstimate: p }; }
  if (input.allowedSupplierNumbers !== undefined) next.allowedSupplierNumbers = (Array.isArray(input.allowedSupplierNumbers) ? input.allowedSupplierNumbers : String(input.allowedSupplierNumbers).split(/[\s,]+/)).map(digits).filter((n) => n.length >= 8 && n.length <= 15).slice(0, 200);
  if (input.bookkeeperSourceId !== undefined) next.bookkeeperSourceId = input.bookkeeperSourceId ? sid(input.bookkeeperSourceId) : null;
  const c = await ccol();
  await c.updateOne({ orgId: oid(orgId), kind: K.settings }, { $set: { settings: next, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { orgId: oid(orgId), kind: K.settings, opsDoc: true, createdAt: nowIso() } }, { upsert: true });
  await audit({ orgId, actorEmail, action: "CONNECT_SETTINGS_UPDATED", metadata: { keys: Object.keys(input) } });
  return { settings: next };
}

// ------------------------------------------------------------------ helpers
export const digits = (v) => String(v || "").replace(/[^\d]/g, "");
export const sha256 = (v) => createHash("sha256").update(v).digest("hex");
export const token = (n = 18) => randomBytes(n).toString("base64url");
export const secretOf = (enc) => { try { return enc ? decryptIntegrationSecret(enc) : null; } catch { return null; } };
export function safeEqual(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
/** Masks a phone number for logs and screens: +92•••••4567 */
export const maskPhone = (p) => { const d = digits(p); return d.length > 4 ? `+${d.slice(0, 2)}${"•".repeat(Math.max(0, d.length - 6))}${d.slice(-4)}` : "•••"; };
export async function audit({ orgId, actorEmail, action, recordId = null, metadata = {} }) {
  return baseAudit({ orgId, actorEmail: actorEmail || "system:inaya-connect", recordType: "INAYA_CONNECT", recordId: recordId || orgId, action, metadata });
}
/** Operational event (monitoring + audit trail without message content). */
export async function event({ orgId = null, type, outcome, connId = null, waMessageId = null, contact = null, detail = {} }) {
  try { const c = await ccol(); await c.insertOne({ orgId: orgId ? oid(orgId) : null, kind: K.event, opsDoc: true, type, outcome, connId: oid(connId), waMessageId: waMessageId || null, contact: contact ? maskPhone(contact) : null, detail, at: nowIso() }); }
  catch (e) { console.error("connect event failed:", e?.message); }
}
export function isOpenNow(hours, now = new Date()) {
  if (hours?.alwaysOpen) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: hours?.timezone || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday]; const hm = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  return (hours?.weekly?.[day] || []).some(([a, b]) => hm >= a && hm < b);
}

let ready = null;
export async function ensureConnectIndexes() {
  if (ready) return ready; const c = await ccol();
  ready = Promise.all([
    c.createIndex({ waKey: 1 }, { unique: true, partialFilterExpression: { waKey: { $exists: true } }, name: "wa_key" }),
  ]).catch((e) => { ready = null; throw e; });
  return ready;
}
