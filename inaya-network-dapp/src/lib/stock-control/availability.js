// src/lib/stock-control/availability.js -- Inaya Commerce Phase 3 (Master SOW 7.4): stock balances and availability.
//
// ONE formula, used by the till, sales orders, transfers and (later) the online store:
//   on hand      = stock_levels.quantity (the cache of the movement ledger; reconciled nightly)
//   reserved     = stock_levels.reserved (held for confirmed sales orders; a requested transfer also reserves its stock
//                  at the source until it is dispatched, when the stock leaves the source and is "in transit")
//   AVAILABLE    = on hand - reserved                      <- what the till / an order / a transfer may take
//   in transit   = dispatched transfers to this location not yet received (counted at the destination, not on hand)
//   incoming     = open purchase-order quantity still to be received for this location (+ its expected date)
//   backordered  = sales-order quantity confirmed as backorder from this location and not yet reserved
//   quarantined  = on hand at the company's quarantine location (never available for sale)
//   AVAILABLE TO PROMISE (ATP) = available + in transit + incoming - backordered   (never negative)
// Kits have no stock of their own: a kit's availability is the number of whole kits its components allow.
// Negative stock is refused unless the company's commerce setting allows it (with a recorded reason per movement).
import { getOrgCollections, toObjectId } from "../orgs.js";
import { ccol } from "../commerce/store.js";

export const TRANSFER_KIND = "i_transfer";
const r6 = (n) => Math.round(n * 1e6) / 1e6;

export async function availability({ orgId, productIds = null, warehouseId = null }) {
  const { stockLevels, products, purchaseOrders, salesOrders, warehouses } = await getOrgCollections();
  const o = toObjectId(orgId);
  const pq = { orgId: o, deletedAt: null, ...(productIds ? { _id: { $in: productIds.map(toObjectId) } } : {}) };
  const prods = await products.find(pq, { projection: { name: 1, sku: 1, productType: 1, kitComponents: 1, reorderThreshold: 1, minStock: 1, maxStock: 1, safetyStock: 1, locationRules: 1, unit: 1 } }).limit(5000).toArray();
  const whs = await warehouses.find({ orgId: o, ...(warehouseId ? { _id: toObjectId(warehouseId) } : {}) }, { projection: { name: 1 } }).toArray();
  const { getSettings } = await import("../commerce/store.js");
  const quarantineId = (await getSettings(orgId).catch(() => ({}))).quarantineWarehouseId || null;
  const key = (p, w) => `${p}:${w}`;
  const grid = new Map();
  const cell = (p, w) => { const k = key(p, w); if (!grid.has(k)) grid.set(k, { onHand: 0, reserved: 0, inTransit: 0, incoming: 0, nextExpected: null, backordered: 0 }); return grid.get(k); };
  for (const l of await stockLevels.find({ orgId: o, ...(warehouseId ? { warehouseId: toObjectId(warehouseId) } : {}) }).toArray()) { const c = cell(l.productId, l.warehouseId); c.onHand = l.quantity || 0; c.reserved = l.reserved || 0; }
  // in transit: dispatched transfers (Phase 3 transfer lifecycle) not yet fully received, counted at the destination
  const c = await ccol();
  for (const t of await c.find({ orgId: o, kind: TRANSFER_KIND, status: { $in: ["DISPATCHED", "PARTIALLY_RECEIVED"] }, ...(warehouseId ? { toWarehouseId: toObjectId(warehouseId) } : {}) }).toArray())
    for (const l of t.lines) { const open = r6(l.dispatchedQty - (l.receivedQty || 0) - (l.shortQty || 0)); if (open > 0) cell(l.productId, t.toWarehouseId).inTransit += open; }
  // incoming: open purchase orders
  for (const po of await purchaseOrders.find({ orgId: o, deletedAt: null, status: { $in: ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"] } }, { projection: { items: 1, expectedDeliveryDate: 1, status: 1 } }).toArray())
    for (const it of po.items || []) {
      if (!it.productId || !it.warehouseId || (warehouseId && String(it.warehouseId) !== String(warehouseId))) continue;
      const per = Number(it.unitsPerPurchaseUnit) > 0 ? Number(it.unitsPerPurchaseUnit) : 1;
      const open = r6((it.quantity - (it.receivedQuantity || 0)) * per); if (open <= 0) continue;
      const x = cell(it.productId, it.warehouseId); x.incoming += open;
      if (po.expectedDeliveryDate && (!x.nextExpected || po.expectedDeliveryDate < x.nextExpected)) x.nextExpected = po.expectedDeliveryDate;
    }
  // backordered: sales orders waiting for stock
  for (const ord of await salesOrders.find({ orgId: o, channel: { $ne: "POS" }, status: "BACKORDERED", ...(warehouseId ? { warehouseId: toObjectId(warehouseId) } : {}) }, { projection: { lines: 1, warehouseId: 1 } }).toArray())
    for (const l of ord.lines) {
      const short = r6(l.quantity - (l.reservedQty || 0)); if (short <= 0) continue;
      const legs = l.productType === "KIT" ? (l.kitComponents || []).map((k) => [k.productId, k.quantity]) : ["SERVICE", "NON_STOCK"].includes(l.productType) ? [] : [[l.productId, 1]];
      for (const [p, per] of legs) cell(p, ord.warehouseId).backordered += short * per;
    }
  const out = [];
  for (const p of prods) {
    if (["SERVICE", "NON_STOCK"].includes(p.productType)) continue;
    for (const w of whs) {
      let v;
      if (p.productType === "KIT") {
        const comps = p.kitComponents || []; if (!comps.length) continue;
        let kits = Infinity; for (const k of comps) { const x = grid.get(key(k.productId, w._id)) || { onHand: 0, reserved: 0 }; kits = Math.min(kits, Math.floor((Math.max(0, x.onHand - x.reserved)) / k.quantity + 1e-9)); }
        v = { onHand: null, reserved: null, available: kits === Infinity ? 0 : kits, inTransit: null, incoming: null, backordered: null, atp: kits === Infinity ? 0 : kits, kit: true };
      } else {
        const x = grid.get(key(p._id, w._id)); if (!x && !productIds) continue;
        const z = x || { onHand: 0, reserved: 0, inTransit: 0, incoming: 0, nextExpected: null, backordered: 0 };
        const available = r6(z.onHand - z.reserved);
        v = { onHand: r6(z.onHand), reserved: r6(z.reserved), available, inTransit: r6(z.inTransit), incoming: r6(z.incoming), nextExpected: z.nextExpected, backordered: r6(z.backordered), atp: Math.max(0, r6(available + z.inTransit + z.incoming - z.backordered)) };
      }
      const rule = (p.locationRules || []).find((r) => r.warehouseId === String(w._id)) || {};
      const reorderAt = rule.reorderThreshold ?? p.reorderThreshold ?? null; const minStock = rule.minStock ?? p.minStock ?? null; const maxStock = rule.maxStock ?? p.maxStock ?? null; const safety = rule.safetyStock ?? p.safetyStock ?? null;
      out.push({ productId: String(p._id), sku: p.sku, name: p.name, unit: p.unit || "each", warehouseId: String(w._id), warehouse: w.name, quarantine: String(w._id) === String(quarantineId), ...v,
        reorderAt, minStock, maxStock, safetyStock: safety, bin: rule.bin || null,
        status: v.kit ? null : String(w._id) === String(quarantineId) ? "QUARANTINE" : v.available <= 0 ? "OUT" : (safety != null && v.available <= safety) ? "BELOW_SAFETY" : (reorderAt != null && reorderAt > 0 && v.available <= reorderAt) || (minStock != null && v.available < minStock) ? "REORDER" : (maxStock != null && v.onHand > maxStock) ? "OVER_MAX" : "OK" });
    }
  }
  return { formula: "available = on hand - reserved; ATP = available + in transit + incoming - backordered", rows: out };
}
