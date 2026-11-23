// src/lib/licensing/admin.js -- the Inaya Admin Portal's License Manager reads (SOW sections 6, 13).
//
// All counts come from the database (no sample values). Status filters use the EFFECTIVE state (state.js), so
// "payment overdue" means overdue right now even if the hourly job has not run yet. Licenses are few (one per
// company), so filtering and paging happen on the server after one indexed query.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { PLANS } from "../orgPlans.js";
import { toXlsxWorkbook } from "../bookkeeper/exportFormats.js";
import { effectiveState, STATE_LABELS } from "./state.js";
import { licenseCollections } from "./service.js";
import { LICENSE_PAYMENT_METHODS, autoSuspendEnabled } from "./config.js";

const DAY = 86400000;
const FILTERS = ["status", "cycle", "plan", "currency", "method", "q", "dueFrom", "dueTo", "graceFrom", "graceTo", "activatedFrom", "activatedTo", "renewalsWithinDays"];

/** The License Manager filters from a request URL (the list and the Excel export use the same ones). */
export function filtersFrom(url) {
  const f = {};
  for (const k of FILTERS) { const v = url.searchParams.get(k); if (v) f[k] = String(v).slice(0, 80); }
  return f;
}
const MAX = 5000;
const dateOnly = (v) => (v ? String(v).slice(0, 10) : "");
const inRange = (v, from, to) => { if (!from && !to) return true; if (!v) return false; const d = dateOnly(v); return (!from || d >= from) && (!to || d <= to); };

/** Every license with its company name and effective state. */
async function loadAll(now) {
  const { subs } = await licenseCollections();
  const { orgs } = await getOrgCollections();
  const rows = await subs.find({ licenseId: { $exists: true } }).limit(MAX).toArray();
  const names = new Map((await orgs.find({ _id: { $in: rows.map((r) => r.orgId) } }, { projection: { name: 1 } }).toArray()).map((o) => [String(o._id), o.name]));
  return rows.map((r) => ({ ...r, companyName: names.get(String(r.orgId)) || "(company removed)", effective: effectiveState(r, now) }));
}

function matches(r, f, now) {
  if (f.q) { const q = String(f.q).toLowerCase(); if (![r.companyName, String(r.orgId), r.licenseId].some((v) => String(v || "").toLowerCase().includes(q))) return false; }
  if (f.status && f.status !== "all") {
    const want = String(f.status).split(",");
    const st = r.effective.suspensionDue ? "grace_period" : r.effective.state;
    if (!want.includes(st) && !(want.includes("ended") && ["suspended", "cancelled", "expired"].includes(st))) return false;
  }
  if (f.cycle && r.billingCycle !== f.cycle) return false;
  if (f.plan && r.planId !== f.plan) return false;
  if (f.currency && r.currency !== f.currency) return false;
  if (f.method && r.lastPaymentMethod !== f.method) return false;
  if (!inRange(r.nextPaymentDueDate, f.dueFrom, f.dueTo)) return false;
  if (!inRange(r.graceEndsAt, f.graceFrom, f.graceTo)) return false;
  if (!inRange(r.activatedAt, f.activatedFrom, f.activatedTo)) return false;
  if (f.renewalsWithinDays) { const d = Number(f.renewalsWithinDays); const due = r.paymentDueAt ? new Date(r.paymentDueAt).getTime() : null; if (!due || due < now.getTime() || due > now.getTime() + d * DAY) return false; }
  return true;
}

export function rowView(r) {
  return {
    orgId: String(r.orgId), companyName: r.companyName, licenseId: r.licenseId, plan: r.planSnapshot?.name || r.planId, planId: r.planId,
    billingCycle: r.billingCycle, currency: r.currency, amount: r.amount, status: r.effective.state, statusLabel: STATE_LABELS[r.effective.state] || r.effective.state,
    storedStatus: r.licenseStatus, suspensionDue: !!r.effective.suspensionDue, activatedAt: r.activatedAt || null, paidThroughDate: r.paidThroughDate || null,
    nextPaymentDueDate: r.nextPaymentDueDate || null, paymentDueAt: r.paymentDueAt || null, graceEndsAt: r.graceEndsAt || null, suspendedAt: r.suspendedAt || null,
    lastPaymentAt: r.lastPaymentAt || null, lastPaymentMethod: r.lastPaymentMethod || null, managedBy: r.updatedBy || r.createdBy || null, updatedAt: r.updatedAt || null,
    needsReview: !!r.needsReview, overrideUntil: r.overrideUntil || null, pendingChange: r.pendingChange || null,
  };
}

/** The License Manager table: filters, search and paging. */
export async function listLicenses(filters = {}, { page = 1, pageSize = 25, now = new Date() } = {}) {
  const all = (await loadAll(now)).filter((r) => matches(r, filters, now));
  all.sort((a, b) => String(a.paymentDueAt || "9").localeCompare(String(b.paymentDueAt || "9")));
  const size = Math.min(200, Math.max(1, Number(pageSize) || 25)); const p = Math.max(1, Number(page) || 1);
  return { total: all.length, page: p, pageSize: size, rows: all.slice((p - 1) * size, p * size).map(rowView) };
}

/** Dashboard counters (SOW 6.1), from the same data and the same filters when given. */
export async function licenseSummary(filters = {}, { now = new Date(), renewalDays = 30 } = {}) {
  const rows = (await loadAll(now)).filter((r) => matches(r, filters, now));
  const by = (fn) => rows.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const st = by((r) => r.effective.state);
  return {
    total: rows.length, active: (st.active || 0) + (st.admin_override || 0), pendingActivation: st.pending_activation || 0, gracePeriod: st.grace_period || 0,
    suspended: st.suspended || 0, cancelledOrExpired: (st.cancelled || 0) + (st.expired || 0), monthly: rows.filter((r) => r.billingCycle === "monthly").length, yearly: rows.filter((r) => r.billingCycle === "yearly").length,
    renewalsDue: rows.filter((r) => r.paymentDueAt && new Date(r.paymentDueAt) >= now && new Date(r.paymentDueAt) <= new Date(now.getTime() + renewalDays * DAY)).length, renewalDays,
    suspensionDue: rows.filter((r) => r.effective.suspensionDue).length, needsReview: rows.filter((r) => r.needsReview).length,
    byPlan: by((r) => r.planSnapshot?.name || r.planId), autoSuspend: autoSuspendEnabled(),
  };
}

/** Companies for the "assign a license" picker: name / id search, with their current license state. */
export async function searchCompanies(q, { limit = 20 } = {}) {
  const { orgs } = await getOrgCollections();
  const { subs } = await licenseCollections();
  const term = String(q || "").trim();
  let query = {};
  if (/^[0-9a-f]{24}$/i.test(term)) query = { _id: toObjectId(term) };
  else if (term) query = { name: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } };
  const list = await orgs.find(query, { projection: { name: 1, ownerEmail: 1, plan: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(Math.min(50, limit)).toArray();
  const lic = new Map((await subs.find({ orgId: { $in: list.map((o) => o._id) } }, { projection: { orgId: 1, licenseId: 1, licenseStatus: 1 } }).toArray()).map((s) => [String(s.orgId), s]));
  return list.map((o) => ({ orgId: String(o._id), name: o.name, ownerEmail: o.ownerEmail || null, plan: o.plan || null, createdAt: o.createdAt || null, licenseId: lic.get(String(o._id))?.licenseId || null, licenseStatus: lic.get(String(o._id))?.licenseStatus || null }));
}

/** The four-sheet workbook (SOW 13.3): register, payments, activity, summary -- plus About (time and filters). */
export async function buildLicenseWorkbook(filters = {}, { now = new Date() } = {}) {
  const { ledger } = await licenseCollections();
  const rows = (await loadAll(now)).filter((r) => matches(r, filters, now));
  const orgIds = rows.map((r) => r.orgId);
  const nameOf = new Map(rows.map((r) => [String(r.orgId), r.companyName]));
  const [payments, events] = await Promise.all([
    ledger.find({ kind: "license_payment", orgId: { $in: orgIds } }).sort({ createdAt: -1 }).limit(20000).toArray(),
    ledger.find({ kind: "license_event", orgId: { $in: orgIds } }).sort({ at: -1 }).limit(20000).toArray(),
  ]);
  const register = rows.map((r) => ({
    "Company name": r.companyName, "Organization ID": String(r.orgId), "License ID": r.licenseId, "Current status": STATE_LABELS[r.effective.state] || r.effective.state, Package: r.planSnapshot?.name || r.planId,
    "Billing cycle": r.billingCycle, Currency: r.currency, "Subscription amount": r.amount, "Activation date": dateOnly(r.activatedAt), "Paid-through date": r.paidThroughDate || "", "Next payment due date": r.nextPaymentDueDate || "",
    "Grace-period start": dateOnly(r.graceStartedAt || (r.effective.state === "grace_period" ? r.paymentDueAt : "")), "Grace-period end": r.graceEndsAt || "", "Suspension date": dateOnly(r.suspendedAt), "Last payment date": dateOnly(r.lastPaymentAt),
    "Payment method": LICENSE_PAYMENT_METHODS[r.lastPaymentMethod] || r.lastPaymentMethod || "", "Created date": dateOnly(r.createdAt), "Last updated": r.updatedAt || "",
  }));
  const paymentRows = payments.map((p) => ({
    "Payment ID": String(p._id), Company: nameOf.get(String(p.orgId)) || "", "Organization ID": String(p.orgId), "License ID": p.licenseId || "", "Subscription ID": p.subscriptionId ? String(p.subscriptionId) : "",
    Amount: p.amount, Currency: p.currency, Method: LICENSE_PAYMENT_METHODS[p.method] || p.method, "Payment reference": p.reference || "", "Received date": dateOnly(p.receivedAt), "Confirmation date": dateOnly(p.confirmedAt),
    Status: p.paymentStatus, "Confirmed by": p.confirmedBy || "", "Reversal/correction reference": p.reversalId ? String(p.reversalId) : p.reversalOf ? String(p.reversalOf) : "",
  }));
  const eventRows = events.map((e) => ({ "Event ID": String(e._id), Timestamp: e.at, Company: nameOf.get(String(e.orgId)) || "", "Organization ID": String(e.orgId), "License ID": e.licenseId || "", "Event type": e.eventType, Actor: e.actorId || e.actorType, "Previous state": e.previousState || "", "New state": e.newState || "", Reason: e.reason || "", Source: e.source || "" }));
  const sum = await licenseSummary(filters, { now, renewalDays: Number(filters.renewalsWithinDays) || 30 });
  const summaryRows = [
    ["Total companies", sum.total], ["Active licenses", sum.active], ["Grace-period licenses", sum.gracePeriod], ["Suspended licenses", sum.suspended], ["Pending activation", sum.pendingActivation],
    ["Cancelled / expired", sum.cancelledOrExpired], ["Monthly", sum.monthly], ["Yearly", sum.yearly], [`Renewals due in ${sum.renewalDays} days`, sum.renewalsDue],
    ...Object.entries(sum.byPlan).map(([k, v]) => [`Package: ${k}`, v]),
  ].map(([Measure, Value]) => ({ Measure, Value }));
  const cols = (arr, fallback) => (arr.length ? Object.keys(arr[0]) : fallback);
  const buffer = toXlsxWorkbook({
    sheets: [
      { name: "License Register", columns: cols(register, ["Company name"]), rows: register },
      { name: "Payment History", columns: cols(paymentRows, ["Payment ID"]), rows: paymentRows },
      { name: "License Activity", columns: cols(eventRows, ["Event ID"]), rows: eventRows },
      { name: "Summary", columns: ["Measure", "Value"], rows: summaryRows },
    ],
    about: { Report: "Inaya Business OS license report", "Exported at (UTC)": now.toISOString(), "Filters applied": Object.keys(filters).length ? filters : "none (all licenses)", "Summary scope": "Calculated from the same filtered licenses as the register", Timezone: "Dates are billing dates in PKT; timestamps are UTC" },
  });
  return { buffer, filename: `inaya-licenses-${now.toISOString().slice(0, 10)}.xlsx`, counts: { licenses: register.length, payments: paymentRows.length, events: eventRows.length } };
}

export const PLAN_OPTIONS = () => Object.values(PLANS).filter((p) => !p.noBilling).map((p) => ({ id: p.id, name: p.name, priceMonthlyUsd: p.priceMonthly, priceYearlyUsd: p.priceYearly }));
