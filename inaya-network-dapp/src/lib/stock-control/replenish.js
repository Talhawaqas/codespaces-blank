// src/lib/stock-control/replenish.js -- Inaya Commerce Phase 3 (Master SOW 7.12): replenishment and inventory intelligence.
//
// Method (shown to the user with every recommendation; nothing is presented as certain):
//   demand        = units leaving the location to customers (SALE, ISSUE, CONSUME) minus customer returns, per day, over the
//                   data window (default 90 days). Transfers are not demand.
//   daily rate    = average over the window; variability = standard deviation of daily demand.
//   seasonality   = applied only when a full year of history exists: last-year demand for the next 30 days vs last-year
//                   average (capped 0.5x - 2x); otherwise "not enough history" is stated.
//   lead time     = the supplier's measured average (from receipts), else the catalogue/product lead time, else 7 days
//                   (stated as an assumption).
//   safety stock  = the product/location setting, else 1.65 x variability x sqrt(lead time)  (about 95% service level)
//   reorder point = daily rate x lead time + safety stock;   position = available-to-promise (availability.js)
//   suggest       = when position <= reorder point: up to max stock, or cover for lead time + 14 days + safety stock,
//                   rounded up to the supplier's minimum order and order multiple
//   confidence    = HIGH (>=60 days of history and steady demand), MEDIUM, LOW (little history or very irregular demand)
// Also: stockout risk (days of cover < lead time), overstock (> 180 days of cover or above max), dead stock (nothing out
// for 90 days), slow movers (> 120 days of cover), inter-branch transfer suggestions, margin erosion (latest cost eats
// the margin), supplier lead-time variance, and forecast accuracy (past 30-day forecasts vs what actually sold).
// Overrides need a reason and are kept next to the suggestion they replaced.
import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ccol, ensureCommerceIndexes } from "../commerce/store.js";
import { availability } from "./availability.js";
import { KINDS as PK } from "./purchasing.js";

export const KINDS = { override: "i_reorder_override", forecast: "i_forecast" };
const DAY = 86400000; const OUT_TYPES = ["SALE", "ISSUE", "CONSUME"]; const r2 = (n) => Math.round(n * 100) / 100;
const oid = toObjectId;

async function demandSeries({ orgId, days, end = Date.now() }) {
  const { stockMovements } = await getOrgCollections();
  const since = new Date(end - days * DAY).toISOString();
  const rows = await stockMovements.aggregate([
    { $match: { orgId: oid(orgId), createdAt: { $gte: since, $lt: new Date(end).toISOString() }, type: { $in: [...OUT_TYPES, "RETURN"] } } },
    { $project: { productId: 1, warehouseId: 1, day: { $substrBytes: ["$createdAt", 0, 10] }, units: { $cond: [{ $eq: ["$type", "RETURN"] }, { $multiply: ["$delta", -1] }, { $multiply: ["$delta", -1] }] } } },
    { $group: { _id: { p: "$productId", w: "$warehouseId", d: "$day" }, units: { $sum: "$units" } } },
  ]).toArray();
  const out = new Map();
  for (const r of rows) { const k = `${r._id.p}:${r._id.w}`; if (!out.has(k)) out.set(k, new Map()); out.get(k).set(r._id.d, (out.get(k).get(r._id.d) || 0) + r.units); }
  return out;
}
function stats(dayMap, days, end = Date.now()) {
  const vals = []; let firstSeen = null;
  for (let i = days - 1; i >= 0; i--) { const d = new Date(end - i * DAY).toISOString().slice(0, 10); const v = Math.max(0, dayMap?.get(d) || 0); vals.push(v); if (v > 0 && !firstSeen) firstSeen = d; }
  const n = vals.length; const mean = vals.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const historyDays = firstSeen ? Math.round((end - Date.parse(firstSeen)) / DAY) + 1 : 0;
  return { mean, sd, total: vals.reduce((a, b) => a + b, 0), historyDays, cv: mean ? sd / mean : null };
}

export async function recommendations({ orgId, windowDays = 90, warehouseId = null, record = false }) {
  windowDays = Math.min(365, Math.max(28, Number(windowDays) || 90));
  const { products, suppliers } = await getOrgCollections(); const o = oid(orgId);
  const [series, avail, yearSeries] = await Promise.all([demandSeries({ orgId, days: windowDays }), availability({ orgId, warehouseId }), demandSeries({ orgId, days: 400 })]);
  const prods = new Map((await products.find({ orgId: o, deletedAt: null }, { projection: { name: 1, sku: 1, unitPrice: 1, avgCost: 1, lastPurchaseCost: 1, costPrice: 1, leadTimeDays: 1, preferredSupplierId: 1, status: 1, departmentId: 1 } }).toArray()).map((p) => [String(p._id), p]));
  const c = await ccol();
  const cat = await c.find({ orgId: o, kind: PK.supplierItem }).toArray();
  const supNames = new Map((await suppliers.find({ orgId: o }, { projection: { name: 1 } }).toArray()).map((s) => [String(s._id), s.name]));
  const overrides = await c.find({ orgId: o, kind: KINDS.override }).sort({ at: -1 }).limit(500).toArray();
  // when stock first arrived at each location: a product stocked for less than the window can't be judged dead/slow
  const { stockMovements } = await getOrgCollections();
  const firstIn = new Map((await stockMovements.aggregate([{ $match: { orgId: o, delta: { $gt: 0 } } }, { $group: { _id: { p: "$productId", w: "$warehouseId" }, first: { $min: "$createdAt" } } }]).toArray()).map((x) => [`${x._id.p}:${x._id.w}`, x.first]));
  const rows = []; const byProduct = new Map();
  for (const a of avail.rows) {
    if (a.kit || a.quarantine) continue;
    const p = prods.get(a.productId); if (!p || (p.status && p.status !== "ACTIVE")) continue;
    const k = `${a.productId}:${a.warehouseId}`; const st = stats(series.get(k), windowDays);
    // seasonality: only with a year of history
    let season = null; const yr = yearSeries.get(k);
    if (st.historyDays >= 365 && yr) { const ly = stats(yr, 30, Date.now() - 335 * DAY); const lyAvg = stats(yr, 365, Date.now() - 0 * DAY).mean; if (lyAvg > 0) season = Math.min(2, Math.max(0.5, ly.mean / lyAvg)); }
    const daily = st.mean * (season ?? 1);
    const supItems = cat.filter((x) => String(x.productId) === a.productId);
    const pref = supItems.find((x) => x.preferred) || supItems.find((x) => String(x.supplierId) === p.preferredSupplierId) || supItems[0] || null;
    const measured = pref?.leadTimeHistory?.length ? pref.leadTimeHistory.reduce((n, h) => n + h.days, 0) / pref.leadTimeHistory.length : null;
    const lead = measured ?? pref?.leadTimeDays ?? p.leadTimeDays ?? 7; const leadSource = measured != null ? "measured from past deliveries" : pref?.leadTimeDays != null ? "supplier catalogue" : p.leadTimeDays != null ? "product setting" : "assumed 7 days (no lead time recorded)";
    const leadVar = pref?.leadTimeHistory?.length >= 2 ? Math.sqrt(pref.leadTimeHistory.reduce((n, h) => n + (h.days - measured) ** 2, 0) / pref.leadTimeHistory.length) : null;
    const safety = a.safetyStock ?? Math.ceil(1.65 * st.sd * Math.sqrt(lead));
    const reorderPoint = Math.ceil(daily * lead + safety);
    const position = r2(a.available + (a.inTransit || 0) + (a.incoming || 0) - (a.backordered || 0)); // unclamped: backorders make it negative
    const stockedDays = firstIn.get(k) ? Math.floor((Date.now() - Date.parse(firstIn.get(k))) / DAY) : 0; const tooNew = stockedDays < windowDays;
    const cover = daily > 0 ? r2(a.available / daily) : null;
    let suggest = 0;
    if (daily > 0 || position < 0 || (a.reorderAt != null && position <= a.reorderAt) || (a.minStock != null && position < a.minStock)) {
      if (position < 0 || position <= reorderPoint || (a.minStock != null && position < a.minStock) || (a.reorderAt != null && a.reorderAt > 0 && position <= a.reorderAt)) {
        const target = Math.max(0, a.maxStock != null ? a.maxStock : Math.ceil(daily * (lead + 14) + safety));
        suggest = Math.max(0, Math.ceil(target - position));
        if (pref?.moq && suggest > 0 && suggest < pref.moq) suggest = pref.moq;
        if (pref?.orderMultiple && suggest > 0) suggest = Math.ceil(suggest / pref.orderMultiple) * pref.orderMultiple;
      }
    }
    const confidence = st.historyDays >= 60 && st.cv !== null && st.cv <= 1.5 ? "HIGH" : st.historyDays >= 21 && st.cv !== null ? "MEDIUM" : "LOW";
    const flags = [];
    if (cover !== null && cover < lead) flags.push({ kind: "STOCKOUT_RISK", text: `About ${cover} days of stock left; the next delivery takes about ${r2(lead)} days.` });
    if (a.backordered > 0) flags.push({ kind: "BACKORDERS", text: `${a.backordered} on backorder for customer orders.` });
    if (tooNew && a.onHand > 0 && (st.total <= 0 || (cover !== null && cover > 120))) flags.push({ kind: "TOO_NEW", text: `In stock here for ${stockedDays} day(s): too new to judge whether it sells slowly.` });
    else if (a.onHand > 0 && st.total <= 0) flags.push({ kind: "DEAD_STOCK", text: `Nothing sold or used here in ${windowDays} days, ${a.onHand} on hand.` });
    else if (cover !== null && cover > 180) flags.push({ kind: "OVERSTOCK", text: `About ${Math.round(cover)} days of stock at the current rate.` });
    else if (cover !== null && cover > 120) flags.push({ kind: "SLOW_MOVING", text: `About ${Math.round(cover)} days of stock at the current rate.` });
    if (a.maxStock != null && a.onHand > a.maxStock) flags.push({ kind: "ABOVE_MAX", text: `${a.onHand} on hand, maximum ${a.maxStock}.` });
    const latest = p.lastPurchaseCost ?? null, avg = p.avgCost ?? p.costPrice ?? null, price = p.unitPrice ?? null;
    if (price && latest != null && avg != null) { const mA = (price - avg) / price, mL = (price - latest) / price; if (mL < 0 || mA - mL >= 0.05) flags.push({ kind: "MARGIN_EROSION", text: `Latest purchase cost ${latest} leaves a ${Math.round(mL * 100)}% margin (average cost gives ${Math.round(mA * 100)}%). Review the price.` }); }
    if (leadVar != null && leadVar >= 3) flags.push({ kind: "LEAD_TIME_VARIANCE", text: `This supplier's deliveries vary by about ±${r2(leadVar)} days.` });
    const ov = overrides.find((x) => x.productId === a.productId && x.warehouseId === a.warehouseId && Date.now() - Date.parse(x.at) < 30 * DAY);
    const row = { productId: a.productId, sku: a.sku, name: a.name, warehouseId: a.warehouseId, warehouse: a.warehouse, available: a.available, atp: a.atp, onHand: a.onHand, incoming: a.incoming, inTransit: a.inTransit,
      dailyDemand: r2(daily), daysOfCover: cover, leadTimeDays: r2(lead), safetyStock: safety, reorderPoint, suggestedQty: suggest,
      supplier: pref ? { id: String(pref.supplierId), name: supNames.get(String(pref.supplierId)) || null, price: pref.price ?? null, moq: pref.moq ?? null, orderMultiple: pref.orderMultiple ?? null } : null,
      confidence, flags, override: ov ? { quantity: ov.quantity, reason: ov.reason, by: ov.by, at: ov.at } : null,
      explanation: `Over the last ${windowDays} days ${r2(st.total)} units left this location (about ${r2(st.mean)} a day${season ? `, adjusted ×${r2(season)} for last year's season` : ""}). Lead time ${r2(lead)} days (${leadSource}); safety stock ${safety}${a.safetyStock != null ? " (set)" : " (calculated, ~95% service level)"}; reorder point ${reorderPoint}. Position (available + in transit + incoming − backordered): ${position}.${suggest ? ` Suggest ordering ${suggest}${a.maxStock != null ? ` (up to the maximum of ${a.maxStock})` : " (lead time + 14 days of cover + safety stock)"}${pref?.moq || pref?.orderMultiple ? ", rounded to the supplier's minimum/multiple" : ""}.` : " No order needed now."}`,
      dataWindow: { days: windowDays, historyDays: st.historyDays, seasonality: season === null ? "not applied (needs a year of history)" : r2(season) } };
    rows.push(row);
    if (!byProduct.has(a.productId)) byProduct.set(a.productId, []); byProduct.get(a.productId).push(row);
  }
  // inter-branch transfer suggestions: a short location and a location with plenty of cover
  for (const list of byProduct.values()) for (const short of list.filter((r) => r.suggestedQty > 0)) {
    const donor = list.filter((r) => r !== short && r.available > 0 && (r.dailyDemand === 0 ? r.available > 0 : r.daysOfCover > short.leadTimeDays * 2 + 30)).sort((x, y) => (y.daysOfCover ?? 1e9) - (x.daysOfCover ?? 1e9))[0];
    if (donor) { const spare = Math.floor(donor.dailyDemand ? donor.available - donor.dailyDemand * (donor.leadTimeDays * 2 + 30) : donor.available); if (spare > 0) short.transferSuggestion = { fromWarehouseId: donor.warehouseId, from: donor.warehouse, quantity: Math.min(spare, short.suggestedQty), text: `${donor.warehouse} has spare stock: transfer up to ${Math.min(spare, short.suggestedQty)} instead of buying.` }; }
  }
  if (record) {
    await ensureCommerceIndexes(); const at = new Date().toISOString().slice(0, 10);
    const ops = rows.filter((r) => r.dailyDemand > 0).map((r) => ({ updateOne: { filter: { orgId: o, kind: KINDS.forecast, productId: r.productId, warehouseId: r.warehouseId, day: at }, update: { $setOnInsert: { orgId: o, kind: KINDS.forecast, productId: r.productId, warehouseId: r.warehouseId, day: at, predictedDaily: r.dailyDemand, horizonDays: 30, createdAt: new Date().toISOString() } }, upsert: true } }));
    if (ops.length) await c.bulkWrite(ops.slice(0, 5000), { ordered: false }).catch(() => {});
  }
  return { method: "See explanation on each row. Forecasts are estimates, not certainties.", windowDays, rows: rows.sort((x, y) => (y.suggestedQty > 0) - (x.suggestedQty > 0) || (x.daysOfCover ?? 1e9) - (y.daysOfCover ?? 1e9)) };
}

/** Forecasts made at least 30 days ago vs what actually left the location in the 30 days after (MAPE). */
export async function forecastAccuracy({ orgId }) {
  const c = await ccol(); const { stockMovements } = await getOrgCollections(); const o = oid(orgId);
  const cutoff = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const snaps = await c.find({ orgId: o, kind: KINDS.forecast, day: { $lte: cutoff } }).sort({ day: -1 }).limit(500).toArray();
  const out = [];
  for (const s of snaps) {
    const from = `${s.day}T00:00:00.000Z`, to = new Date(Date.parse(from) + 30 * DAY).toISOString();
    const agg = await stockMovements.aggregate([{ $match: { orgId: o, productId: oid(s.productId), warehouseId: oid(s.warehouseId), createdAt: { $gte: from, $lt: to }, type: { $in: [...OUT_TYPES, "RETURN"] } } }, { $group: { _id: null, d: { $sum: "$delta" } } }]).toArray();
    const actual = Math.max(0, -(agg[0]?.d || 0)); const predicted = s.predictedDaily * 30;
    out.push({ productId: s.productId, warehouseId: s.warehouseId, day: s.day, predicted: r2(predicted), actual: r2(actual), errorPercent: actual ? r2((Math.abs(predicted - actual) / actual) * 100) : null });
  }
  const scored = out.filter((x) => x.errorPercent !== null);
  return { forecasts: out.slice(0, 200), evaluated: scored.length, mape: scored.length ? r2(scored.reduce((n, x) => n + x.errorPercent, 0) / scored.length) : null, note: scored.length ? "Average error of 30-day forecasts against actual sales." : "Accuracy appears once forecasts are 30 days old." };
}

/** A person decides a different quantity: kept with the reason, next to the suggestion it replaced. */
export async function overrideRecommendation({ orgId, membership, actorEmail, input }) {
  const reason = String(input.reason || "").trim(); if (reason.length < 3) return { error: "Give a reason for the override.", status: 400 };
  const q = Number(input.quantity); if (!(q >= 0)) return { error: "Quantity must be zero or more.", status: 400 };
  await ensureCommerceIndexes(); const c = await ccol(); const at = new Date().toISOString();
  await c.insertOne({ orgId: oid(orgId), kind: KINDS.override, productId: String(input.productId), warehouseId: String(input.warehouseId), quantity: q, suggested: Number(input.suggested ?? null), reason, by: actorEmail, at });
  await logOrgActivity({ orgId: oid(orgId), recordType: "REORDER", recordId: oid(input.productId), actorEmail, action: "REORDER_OVERRIDDEN", previousState: null, newState: null, metadata: { warehouseId: input.warehouseId, suggested: input.suggested ?? null, quantity: q, reason } }).catch(() => {});
  return { ok: true };
}

/** Turns a (possibly overridden) recommendation into a DRAFT purchase request for the suggested supplier. */
export async function requestFromRecommendation({ orgId, membership, actorEmail, input }) {
  const { products, purchaseRequests } = await getOrgCollections(); const o = oid(orgId);
  const p = await products.findOne({ _id: oid(input.productId), orgId: o, deletedAt: null }); if (!p) return { error: "Product not found.", status: 404 };
  const q = Number(input.quantity); if (!(q > 0)) return { error: "Quantity must be positive.", status: 400 };
  const now = new Date().toISOString();
  const open = await purchaseRequests.findOne({ orgId: o, reorderForProductId: p._id, status: { $in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] }, deletedAt: null });
  if (open) return { request: { id: String(open._id), status: open.status }, created: false };
  const doc = { orgId: o, departmentId: p.departmentId, supplierId: input.supplierId ? oid(input.supplierId) : null, title: `Reorder: ${p.sku} — ${p.name}`, description: String(input.explanation || "").slice(0, 2000) || `Replenishment suggestion: ${q}.`,
    estimatedCost: Number.isFinite(Number(input.unitPrice)) ? Math.round(Number(input.unitPrice) * q * 100) / 100 : null, status: "DRAFT", reorderForProductId: p._id, reorderQuantity: q, reorderWarehouseId: input.warehouseId ? oid(input.warehouseId) : null, reorderSource: "replenishment",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null };
  const r = await purchaseRequests.insertOne(doc);
  await logOrgActivity({ orgId: o, recordType: "PURCHASE_REQUEST", recordId: r.insertedId, actorEmail, action: "REORDER_DRAFTED", previousState: null, newState: "DRAFT", metadata: { productId: String(p._id), quantity: q, source: "replenishment" } }).catch(() => {});
  return { request: { id: String(r.insertedId), status: "DRAFT" }, created: true };
}

/** Inventory valuation by branch (7.5): on hand x average cost per location, with the share of value that has no cost. */
export async function valuation({ orgId }) {
  const { stockLevels, products, warehouses } = await getOrgCollections(); const o = oid(orgId);
  const prods = new Map((await products.find({ orgId: o }, { projection: { avgCost: 1, costPrice: 1 } }).toArray()).map((p) => [String(p._id), p.avgCost ?? p.costPrice ?? null]));
  const whs = new Map((await warehouses.find({ orgId: o }, { projection: { name: 1 } }).toArray()).map((w) => [String(w._id), w.name]));
  const by = new Map();
  for (const l of await stockLevels.find({ orgId: o, quantity: { $gt: 0 } }).toArray()) {
    const w = String(l.warehouseId); const b = by.get(w) || { warehouseId: w, warehouse: whs.get(w) || "?", value: 0, units: 0, uncostedUnits: 0, products: 0 };
    const cost = prods.get(String(l.productId)); b.units += l.quantity; b.products++; if (cost == null) b.uncostedUnits += l.quantity; else b.value += l.quantity * cost; by.set(w, b);
  }
  const rows = [...by.values()].map((b) => ({ ...b, value: r2(b.value), estimate: b.uncostedUnits > 0 }));
  return { branches: rows, total: r2(rows.reduce((n, b) => n + b.value, 0)), note: "Valued at moving-average cost. Branches marked as estimates hold products without a recorded cost." };
}
