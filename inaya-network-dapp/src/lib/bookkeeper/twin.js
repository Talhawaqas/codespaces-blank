// src/lib/bookkeeper/twin.js
//
// AI Bookkeeper SOW sections 34, 56: READ-ONLY finance scenarios for the existing Digital Twin. Every handler only reads (find / aggregate); none
// writes to any collection, posts anything, sends anything or touches a bank connection. Every result is labelled
//   SIMULATED - NOT A LIVE FINANCIAL RECORD
// and states what it does not know (no opening balance, no payment behaviour model). The Twin's own entry point records the simulation request.

import { toObjectId, canAccessFinance, canAccessDepartment } from "../orgs.js";
import { getBookkeeperCollections } from "./db.js";
import { cents, fromCents, comparableAmount, vendorSimilarity } from "./common.js";

export const BOOKKEEPER_SCENARIOS = ["SUPPLIER_PAYMENT_DELAYED", "EXPENSES_INCREASED", "RECEIPTS_DELAYED"];
export const SIM_LABEL = "SIMULATED - NOT A LIVE FINANCIAL RECORD";
const unknown = (reason) => ({ status: "UNKNOWN", reason });
const HORIZON_DAYS = 60;

async function scopeDepartments(orgId, membership) {
  const { departments } = await getBookkeeperCollections();
  const all = await departments.find({ orgId: toObjectId(orgId) }).project({ _id: 1 }).toArray();
  return all.filter((d) => canAccessDepartment(membership, d._id)).map((d) => d._id);
}

const usd = (amount, currency) => { const r = comparableAmount(amount, currency || "USD", "USD"); return r.error ? null : r.amount; };
const day = (d) => Math.floor((Date.parse(d) - Date.now()) / 86400000);

/** Open payables (captured supplier bills not fully allocated) and receivables (sent invoices), with due dates. Read only. */
async function openItems({ orgId, deptIds }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId);
  const bills = await c.bkDocuments.find({ orgId: oid, departmentId: { $in: deptIds }, documentType: "SUPPLIER_INVOICE", status: { $in: ["EXTRACTED", "PROCESSED", "NEEDS_REVIEW"] }, postedExpenseId: { $exists: false } }).limit(3000).toArray();
  const recv = await c.invoices.find({ orgId: oid, departmentId: { $in: deptIds }, deletedAt: null, status: { $in: ["SENT", "OVERDUE"] } }).limit(3000).toArray();
  const payables = bills.map((b) => ({ id: String(b._id), party: b.fields?.vendor?.value || "", due: b.fields?.dueDate?.value || b.fields?.invoiceDate?.value || null, usd: usd(b.fields?.total?.value, b.fields?.currency?.value), number: b.fields?.invoiceNumber?.value || "" })).filter((p) => p.due && p.usd !== null);
  const receivables = recv.map((i) => ({ id: String(i._id), party: "", due: i.dueDate ? String(i.dueDate).slice(0, 10) : null, usd: usd(i.total, i.currency), number: i.invoiceNumber })).filter((r) => r.due && r.usd !== null);
  return { payables, receivables };
}

async function averageMonthlyOutflow({ orgId, deptIds }) {
  const c = await getBookkeeperCollections(); const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const rows = await c.bkTransactions.find({ orgId: toObjectId(orgId), departmentId: { $in: deptIds }, direction: "DEBIT", date: { $gte: since }, status: { $ne: "REVERSED" } }).project({ amount: 1, currency: 1, category: 1 }).limit(20000).toArray();
  let total = 0; const cat = new Map();
  for (const r of rows) { const v = usd(r.amount, r.currency); if (v === null) continue; total += v; cat.set(r.category || "Uncategorized", (cat.get(r.category || "Uncategorized") || 0) + v); }
  return { monthly: total / 3, count: rows.length, byCategory: cat };
}

async function guard({ orgId, membership }) {
  if (!canAccessFinance(membership)) return { error: "You don't have finance access.", status: 403 };
  const deptIds = await scopeDepartments(orgId, membership);
  if (!deptIds.length) return { error: "You have no department with finance data.", status: 403 };
  return { deptIds };
}

const base = (type, subject, extra) => ({ scenario: { type, subject, label: SIM_LABEL, ...extra }, noChangesWereMade: true, simulated: true, label: SIM_LABEL });
const sum = (a) => a.reduce((s, x) => s + cents(x.usd), 0);

async function supplierPaymentDelayed({ orgId, entityId, membership, delayDays }) {
  const g = await guard({ orgId, membership }); if (g.error) return g;
  const d = Number(delayDays) || 14; if (!(d > 0 && d <= 180)) return { error: "delayDays must be 1-180.", status: 400 };
  const { payables } = await openItems({ orgId, deptIds: g.deptIds });
  const mine = payables.filter((p) => vendorSimilarity(p.party, entityId) >= 0.85);
  if (!mine.length) return { ...base("SUPPLIER_PAYMENT_DELAYED", { name: entityId }, { params: { delayDays: d } }), directImpact: { status: "NO_IMPACT", note: "No open captured bills from that supplier." }, unknowns: [unknown("Only captured bills are considered; purchase-order commitments are not.")], resultStatus: "COMPLETE" };
  const inHorizon = (p, shift) => day(p.due) + shift <= HORIZON_DAYS;
  const before = mine.filter((p) => inHorizon(p, 0)); const after = mine.filter((p) => inHorizon(p, d));
  return { ...base("SUPPLIER_PAYMENT_DELAYED", { name: entityId }, { params: { delayDays: d, horizonDays: HORIZON_DAYS } }),
    directImpact: { status: "IMPACT_DETECTED", billsConsidered: mine.length, outflowDueWithinHorizonUsd: fromCents(sum(before)), outflowDueWithinHorizonIfDelayedUsd: fromCents(sum(after)), cashRetainedInHorizonUsd: fromCents(sum(before) - sum(after)), affectedBills: mine.slice(0, 20).map((p) => ({ number: p.number, dueDate: p.due, amountUsd: p.usd, newDueDate: new Date(Date.parse(p.due) + d * 86400000).toISOString().slice(0, 10) })) },
    unknowns: [{ area: "SUPPLIER_TERMS_AND_PENALTIES", ...unknown("Late fees, discounts lost and supplier relationship effects are not modelled.") }, { area: "OPENING_BALANCE", ...unknown("No account balance is used; only timing of outflows is compared.") }], resultStatus: "PARTIAL" };
}

async function expensesIncreased({ orgId, entityId, membership, percent }) {
  const g = await guard({ orgId, membership }); if (g.error) return g;
  const p = Number(percent) || 20; if (!(p > -90 && p <= 500)) return { error: "percent must be between -90 and 500.", status: 400 };
  const { monthly, count, byCategory } = await averageMonthlyOutflow({ orgId, deptIds: g.deptIds });
  if (!count) return { ...base("EXPENSES_INCREASED", { name: entityId || "all categories" }, { params: { percent: p } }), directImpact: { status: "NO_DATA", note: "No bank outflows in the last 90 days." }, unknowns: [unknown("Nothing to project from.")], resultStatus: "PARTIAL" };
  const cat = entityId && entityId !== "all" ? byCategory.get(entityId) : null;
  if (entityId && entityId !== "all" && cat === undefined) return { error: `No outflows are categorized as "${entityId}".`, status: 404 };
  const affected = cat !== undefined && cat !== null ? cat / 3 : monthly;
  const extra = affected * (p / 100);
  return { ...base("EXPENSES_INCREASED", { name: entityId && entityId !== "all" ? entityId : "all categories" }, { params: { percent: p } }),
    directImpact: { status: "IMPACT_DETECTED", averageMonthlyOutflowUsd: Math.round(monthly * 100) / 100, affectedMonthlyOutflowUsd: Math.round(affected * 100) / 100, additionalMonthlyOutflowUsd: Math.round(extra * 100) / 100, projectedMonthlyOutflowUsd: Math.round((monthly + extra) * 100) / 100, basis: `${count} bank outflows over the last 90 days, converted to USD with the platform's static dated rates` },
    unknowns: [{ area: "SEASONALITY", ...unknown("Uses a flat three-month average.") }, { area: "OPENING_BALANCE", ...unknown("No account balance is used.") }], resultStatus: "PARTIAL" };
}

async function receiptsDelayed({ orgId, entityId, membership, delayDays }) {
  const g = await guard({ orgId, membership }); if (g.error) return g;
  const d = Number(delayDays) || 10; if (!(d > 0 && d <= 180)) return { error: "delayDays must be 1-180.", status: 400 };
  const { receivables } = await openItems({ orgId, deptIds: g.deptIds });
  const inside = (r, shift) => day(r.due) + shift <= HORIZON_DAYS;
  const before = receivables.filter((r) => inside(r, 0)); const after = receivables.filter((r) => inside(r, d));
  return { ...base("RECEIPTS_DELAYED", { name: entityId || "all customers" }, { params: { delayDays: d, horizonDays: HORIZON_DAYS } }),
    directImpact: { status: receivables.length ? "IMPACT_DETECTED" : "NO_IMPACT", invoicesConsidered: receivables.length, receiptsDueWithinHorizonUsd: fromCents(sum(before)), receiptsDueWithinHorizonIfDelayedUsd: fromCents(sum(after)), receiptsPushedOutsideHorizonUsd: fromCents(sum(before) - sum(after)) },
    unknowns: [{ area: "CUSTOMER_PAYMENT_BEHAVIOUR", ...unknown("Late-payment history per customer is not modelled.") }, { area: "OPENING_BALANCE", ...unknown("No account balance is used.") }], resultStatus: "PARTIAL" };
}

export const BOOKKEEPER_TWIN_HANDLERS = { SUPPLIER_PAYMENT_DELAYED: supplierPaymentDelayed, EXPENSES_INCREASED: expensesIncreased, RECEIPTS_DELAYED: receiptsDelayed };
