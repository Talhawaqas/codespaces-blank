// src/lib/commerce/reports.js -- Inaya Commerce, Batch 4 (Master SOW 6.11): commerce reporting with drill-down.
//
// Every number is computed from the stored transactions (POS sales and the refunds recorded on them) in integer minor
// units, so the report always reconciles to the transactions: each breakdown (by day, hour, employee, register, branch,
// product, category, payment method) sums to the headline totals, and every bucket can be drilled down to the exact
// sales/refunds behind it (`transactions` with the same filter).
//
// Definitions (shown in the UI):
//   Gross sales   = net sales before discounts and returns (excluding tax) = sum(line net + line discounts)
//   Discounts     = line and whole-sale discounts given (as entered; tax-inclusive when shelf prices include tax)
//   Returns       = refunds made in the period (excluding tax), by the date of the refund
//   Net sales     = gross sales - discounts - returns (excluding tax)
//   Tax           = tax on sales - tax reversed on refunds
//   Total collected = sales totals - refund totals (what customers paid, net)
//   ATV           = sales total / number of sales;   UPT = units sold / number of sales
//   Gross margin  = net sales - cost of goods sold; shown as RELIABLE only when every stock line carries a cost
//   Voids are reported separately and excluded from every other figure.
// Sales are attributed to the day/hour they completed and refunds to the day/hour they were made, in the company's
// time zone (Commerce settings), so a period's figures never change after the period closes.
import { ccol, KINDS, fail, oid, sid, commerceAccess, getSettings, fromMinor } from "./store.js";
import { getOrgCollections } from "../orgs.js";

const DAY = 86400000;
function zoneParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour };
}
const add = (map, key, field, v) => { const b = (map[key] ||= { sales: 0, refunds: 0, grossMinor: 0, discountMinor: 0, returnsMinor: 0, netMinor: 0, taxMinor: 0, totalMinor: 0, units: 0 }); b[field] = (b[field] || 0) + v; return b; };

/** Loads the period's transactions once; both the summary and the drill-down use exactly this set. */
async function load({ orgId, from, to, warehouseId, registerId }) {
  const { salesOrders, products, warehouses } = await getOrgCollections(); const o = oid(orgId);
  const base = { orgId: o, channel: "POS" };
  if (warehouseId) base.warehouseId = oid(warehouseId);
  const sales = await salesOrders.find({ ...base, completedAt: { $gte: from, $lt: to }, ...(registerId ? { registerId: oid(registerId) } : {}) }).toArray();
  const withRefunds = await salesOrders.find({ orgId: o, channel: "POS", refunds: { $elemMatch: { createdAt: { $gte: from, $lt: to }, ...(warehouseId ? { warehouseId: oid(warehouseId) } : {}), ...(registerId ? { registerId: oid(registerId) } : {}) } } }).toArray();
  const ids = new Set(); for (const s of [...sales, ...withRefunds]) for (const l of s.lines) ids.add(String(l.productId));
  const prods = await products.find({ orgId: o, _id: { $in: [...ids].map(oid) } }, { projection: { category: 1, name: 1, sku: 1 } }).toArray();
  const cat = new Map(prods.map((p) => [String(p._id), p.category || "Uncategorised"]));
  const whs = new Map((await warehouses.find({ orgId: o }, { projection: { name: 1 } }).toArray()).map((w) => [String(w._id), w.name]));
  const c = await ccol(); const regs = new Map((await c.find({ orgId: o, kind: KINDS.register }).toArray()).map((r) => [String(r._id), r.name]));
  return { sales, withRefunds, cat, whs, regs };
}

/** Each transaction as rows: one per sale line and one per refund line, already attributed to every dimension. */
function rows({ sales, withRefunds, cat, whs, regs }, { from, to, warehouseId, registerId, tz }) {
  const out = [];
  for (const s of sales) {
    const t = zoneParts(s.completedAt, tz); const voided = s.status === "VOIDED";
    const common = { kind: voided ? "void" : "sale", saleId: sid(s._id), number: s.saleNumber, at: s.completedAt, day: t.day, hour: t.hour, employee: s.cashierEmail, register: regs.get(String(s.registerId)) || "No register", branch: whs.get(String(s.warehouseId)) || "?" };
    for (const l of s.lines) {
      const disc = (l.lineDiscountMinor || 0) + (l.orderShareMinor || 0);
      const cost = l.unitCost === null || l.unitCost === undefined ? null : Math.round(l.unitCost * 100 * l.quantity);
      out.push({ ...common, product: `${l.name} (${l.sku})`, category: cat.get(String(l.productId)) || "Uncategorised", units: l.quantity, grossMinor: l.netMinor + disc, discountMinor: disc, netMinor: l.netMinor, taxMinor: l.taxMinor, totalMinor: l.grossMinor, costMinor: cost, stock: !["SERVICE", "NON_STOCK"].includes(l.productType), override: l.priceSource === "override" });
    }
    out.push({ ...common, tenders: s.tenders, changeMinor: s.changeMinor || 0, approval: !!s.approval, isHeader: true });
  }
  for (const s of withRefunds) for (const r of s.refunds || []) {
    if (!(r.createdAt >= from && r.createdAt < to)) continue;
    if (warehouseId && String(r.warehouseId) !== String(warehouseId)) continue;
    if (registerId && String(r.registerId) !== String(registerId)) continue;
    const t = zoneParts(r.createdAt, tz);
    const common = { kind: "refund", saleId: sid(s._id), number: `${r.refundNumber} (${s.saleNumber})`, at: r.createdAt, day: t.day, hour: t.hour, employee: r.processedBy, register: regs.get(String(r.registerId)) || "No register", branch: whs.get(String(r.warehouseId)) || "?" };
    for (const l of r.lines) {
      const sl = s.lines[l.lineIndex]; const cost = sl?.unitCost === null || sl?.unitCost === undefined ? null : Math.round(sl.unitCost * 100 * l.quantity);
      out.push({ ...common, product: `${l.name} (${l.sku})`, category: cat.get(String(l.productId)) || "Uncategorised", units: l.quantity, netMinor: l.netMinor, taxMinor: l.taxMinor, totalMinor: l.grossMinor, costMinor: l.disposition === "RESTOCK" || l.disposition === "QUARANTINE" ? cost : 0, stock: l.disposition !== "NON_RESTOCKABLE" });
    }
    out.push({ ...common, tenders: r.tenders, isHeader: true, isRefund: true });
  }
  return out;
}

const DIMENSIONS = ["day", "hour", "employee", "register", "branch", "product", "category"];
function periodBounds(input, tz) {
  const to = input.to ? new Date(input.to) : new Date(); const from = input.from ? new Date(input.from) : new Date(to.getTime() - 7 * DAY);
  if (!(from < to) || to - from > 400 * DAY) return fail("Choose a period of up to 400 days (from before to).");
  return { from: from.toISOString(), to: to.toISOString(), tz };
}

export async function commerceReport({ orgId, membership, input = {} }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const settings = await getSettings(orgId); const p = periodBounds(input, settings.timezone || "UTC"); if (p.error) return p;
  const data = await load({ orgId, from: p.from, to: p.to, warehouseId: input.warehouseId, registerId: input.registerId });
  const all = rows(data, { ...p, warehouseId: input.warehouseId, registerId: input.registerId });
  const T = { sales: 0, refunds: 0, voids: 0, voidMinor: 0, grossMinor: 0, discountMinor: 0, returnsMinor: 0, returnsTaxMinor: 0, salesTaxMinor: 0, salesNetMinor: 0, salesTotalMinor: 0, refundTotalMinor: 0, units: 0, costMinor: 0, refundCostMinor: 0, costedLines: 0, stockLines: 0, overrides: 0, approvals: 0 };
  const by = Object.fromEntries(DIMENSIONS.map((d) => [d, {}])); const methods = {};
  for (const r of all) {
    if (r.kind === "void") { if (r.isHeader) { T.voids++; } else T.voidMinor += r.totalMinor; continue; }
    if (r.isHeader) {
      if (r.kind === "sale") { T.sales++; for (const d of ["day", "hour", "employee", "register", "branch"]) add(by[d], r[d], "sales", 1); if (r.approval) T.approvals++;
        for (const t of r.tenders) methods[t.method] = (methods[t.method] || 0) + t.amountMinor; if (r.changeMinor) methods.CASH = (methods.CASH || 0) - r.changeMinor; }
      else { T.refunds++; for (const d of ["day", "hour", "employee", "register", "branch"]) add(by[d], r[d], "refunds", 1); for (const t of r.tenders) methods[t.method] = (methods[t.method] || 0) - t.amountMinor; }
      continue;
    }
    if (r.kind === "sale") {
      T.grossMinor += r.grossMinor; T.discountMinor += r.discountMinor; T.salesNetMinor += r.netMinor; T.salesTaxMinor += r.taxMinor; T.salesTotalMinor += r.totalMinor; T.units += r.units; if (r.override) T.overrides++;
      if (r.stock) { T.stockLines++; if (r.costMinor !== null) { T.costedLines++; T.costMinor += r.costMinor; } }
      for (const d of DIMENSIONS) { const b = add(by[d], r[d], "grossMinor", r.grossMinor); b.discountMinor += r.discountMinor; b.netMinor += r.netMinor; b.taxMinor += r.taxMinor; b.totalMinor += r.totalMinor; b.units += r.units; }
    } else {
      T.returnsMinor += r.netMinor; T.returnsTaxMinor += r.taxMinor; T.refundTotalMinor += r.totalMinor; if (r.costMinor) T.refundCostMinor += r.costMinor;
      for (const d of DIMENSIONS) { const b = add(by[d], r[d], "returnsMinor", r.netMinor); b.netMinor -= r.netMinor; b.taxMinor -= r.taxMinor; b.totalMinor -= r.totalMinor; }
    }
  }
  const netMinor = T.salesNetMinor - T.returnsMinor; const reliable = T.stockLines > 0 && T.costedLines === T.stockLines;
  const marginMinor = netMinor - (T.costMinor - T.refundCostMinor);
  const m = fromMinor; const view = (b) => ({ sales: b.sales || 0, refunds: b.refunds || 0, gross: m(b.grossMinor), discounts: m(b.discountMinor), returns: m(b.returnsMinor), net: m(b.netMinor), tax: m(b.taxMinor), total: m(b.totalMinor), units: b.units });
  // cash drawer reconciliation: shifts closed in the period
  const c = await ccol(); const shifts = await c.find({ orgId: oid(orgId), kind: KINDS.shift, status: "CLOSED", closedAt: { $gte: p.from, $lt: p.to }, ...(input.registerId ? { registerId: oid(input.registerId) } : {}), ...(input.warehouseId ? { warehouseId: oid(input.warehouseId) } : {}) }).sort({ closedAt: 1 }).toArray();
  // sales orders in the period (shared lifecycle with online orders later)
  const { salesOrders } = await getOrgCollections();
  const ords = await salesOrders.find({ orgId: oid(orgId), channel: { $ne: "POS" }, createdAt: { $gte: p.from, $lt: p.to }, deletedAt: null }, { projection: { status: 1, total: 1, subtotal: 1, payments: 1 } }).toArray();
  const ordersByStatus = {}; for (const ord of ords) { const b = (ordersByStatus[ord.status] ||= { count: 0, value: 0 }); b.count++; b.value = Math.round((b.value + (ord.total ?? ord.subtotal)) * 100) / 100; }
  return {
    period: { from: p.from, to: p.to, timezone: p.tz }, currency: settings.currency,
    totals: { sales: T.sales, refunds: T.refunds, gross: m(T.grossMinor), discounts: m(T.discountMinor), returns: m(T.returnsMinor), net: m(netMinor), tax: m(T.salesTaxMinor - T.returnsTaxMinor), totalCollected: m(T.salesTotalMinor - T.refundTotalMinor),
      atv: T.sales ? m(Math.round(T.salesTotalMinor / T.sales)) : 0, upt: T.sales ? Math.round((T.units / T.sales) * 100) / 100 : 0, units: T.units,
      grossMargin: { amount: m(marginMinor), percent: netMinor ? Math.round((marginMinor / netMinor) * 10000) / 100 : null, reliable, costCoverage: T.stockLines ? Math.round((T.costedLines / T.stockLines) * 1000) / 10 : null },
      voids: { count: T.voids, total: m(T.voidMinor) }, overrides: { priceOverrides: T.overrides, approvedSales: T.approvals } },
    paymentMethods: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, m(v)])),
    by: Object.fromEntries(DIMENSIONS.map((d) => [d, Object.entries(by[d]).map(([key, b]) => ({ key, ...view(b) })).sort((a, b) => (d === "day" || d === "hour" ? a.key.localeCompare(b.key) : b.net - a.net))])),
    cashDrawers: shifts.map((s) => ({ shiftId: sid(s._id), shiftNumber: s.shiftNumber, registerId: sid(s.registerId), closedAt: s.closedAt, closedBy: s.closedBy, expected: m(s.expectedMinor), counted: m(s.countedMinor), overShort: m(s.varianceMinor), flagged: !!s.flagged, reviewed: !!s.review })),
    cashOverShortTotal: m(shifts.reduce((n, s) => n + (s.varianceMinor || 0), 0)),
    orders: { count: ords.length, byStatus: ordersByStatus },
  };
}

/** Drill-down: the transactions behind any figure (same period/filters plus one dimension value and/or a kind). */
export async function reportTransactions({ orgId, membership, input = {} }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const settings = await getSettings(orgId); const p = periodBounds(input, settings.timezone || "UTC"); if (p.error) return p;
  const data = await load({ orgId, from: p.from, to: p.to, warehouseId: input.warehouseId, registerId: input.registerId });
  const all = rows(data, { ...p, warehouseId: input.warehouseId, registerId: input.registerId }).filter((r) => !r.isHeader);
  const dim = DIMENSIONS.includes(input.dimension) ? input.dimension : null;
  const pick = all.filter((r) => (!dim || r[dim] === input.value) && (!input.kind || r.kind === input.kind));
  const map = new Map();
  for (const r of pick) { const k = `${r.kind}:${r.number}`; const t = map.get(k) || { kind: r.kind, saleId: r.saleId, number: r.number, at: r.at, employee: r.employee, register: r.register, branch: r.branch, units: 0, netMinor: 0, taxMinor: 0, totalMinor: 0 }; t.units += r.units; t.netMinor += r.kind === "refund" ? -r.netMinor : r.netMinor; t.taxMinor += r.kind === "refund" ? -r.taxMinor : r.taxMinor; t.totalMinor += r.kind === "refund" ? -r.totalMinor : r.totalMinor; map.set(k, t); }
  const list = [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
  return { transactions: list.slice(0, 1000).map((t) => ({ kind: t.kind, saleId: t.saleId, number: t.number, at: t.at, employee: t.employee, register: t.register, branch: t.branch, units: t.units, net: fromMinor(t.netMinor), tax: fromMinor(t.taxMinor), total: fromMinor(t.totalMinor) })),
    count: list.length, net: fromMinor(list.filter((t) => t.kind !== "void").reduce((n, t) => n + t.netMinor, 0)) };
}
