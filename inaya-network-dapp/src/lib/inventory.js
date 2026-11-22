// src/lib/inventory.js
//
// Stock movement ledger — the ONLY place stock_levels changes, and always
// via a signed $inc, never a direct $set. stock_movements is the real
// audit trail (append-only, one row per receipt/issue/adjustment/
// transfer); stock_levels is a materialized sum kept in sync with it, the
// same "ledger is truth, balance is a cache of the ledger" relationship
// FAUCET_INAYA_LIFETIME_CAP's getTotalInayaSentToWallet() has to its own
// dispatch history (src/lib/faucet.js) — a snapshot number is never
// trusted on its own, it's always derivable by re-summing the ledger.
//
// This is also the integration point purchase-order-workflow.js's
// "receive" action calls into when a PO line item is linked to a real
// product+warehouse — the one place this pass closes the "PO receiving
// doesn't move real inventory yet" gap the original phased plan flagged
// as an accepted one-release trade-off.

import { randomUUID } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { planLots, applyLots } from "./inventory-lots.js";

// CONSUME / PRODUCE: components used and finished goods made by a production order (production.js).
// SALE / RETURN: POS sales and returns (Inaya Commerce); WRITE_OFF: damaged/expired stock; COUNT: stock-count correction.
export const MOVEMENT_TYPES = ["RECEIPT", "ISSUE", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT", "CONSUME", "PRODUCE", "SALE", "RETURN", "WRITE_OFF", "COUNT"];

/** A stock problem inside a transaction: thrown to abort it, returned to the caller as { error, status }. */
export class StockError extends Error { constructor(message, status = 409, code = "STOCK") { super(message); this.status = status; this.code = code; } }

/** Runs fn(session) in a MongoDB transaction, or inside the caller's transaction when one is passed (a POS sale
 *  completes all of its stock movements, payments and records in ONE transaction). withTransaction retries on
 *  transient write conflicts, which is how two concurrent issues of the same stock are serialised. */
export async function withStockTransaction(fn, session = null) {
  if (session) return fn(session);
  const { connectToDatabase } = await import("./mongodb.js");
  const { client } = await connectToDatabase();
  const s = client.startSession();
  try {
    let out;
    await s.withTransaction(async () => { out = await fn(s); }, { readPreference: "primary", readConcern: { level: "local" }, writeConcern: { w: "majority" } });
    return out;
  } finally { await s.endSession(); }
}

/** Applies a signed stock change and records the movement that caused it, ATOMICALLY (Master SOW 5.4; Lightspeed audit
 *  P0, 21 Nov 2026). The level change, the batch (lot) changes and the movement insert run in one MongoDB transaction,
 *  so the ledger and the balance can no longer diverge if a process dies between writes. A stock-out is a CONDITIONAL
 *  decrement (the level must still hold the quantity at the moment of the write), so two concurrent issues can never
 *  take the same last unit: the loser gets 409. Lot decrements are guarded the same way.
 *  - session: join the caller's transaction (multi-line sales, transfers);
 *  - idempotencyKey: a retried request returns the original movement instead of moving stock again;
 *  - allowNegative: { reason } lets a permitted caller deliberately go below zero; the override is recorded on the
 *    movement. Without it, negative stock is always refused. */
//
// Batch / lot tracking (inventory-lots.js): lotNumber + expiryDate name the
// lot a movement touches, or `lots` lists several explicitly (a transfer's
// IN leg reuses the OUT leg's lots). For a trackLots product a stock-out
// without a lot is allocated earliest-expiry-first, and defaultLotNumber is
// used for a stock-in that names none (PO receipts pass the PO's number).
export async function recordStockMovement({ orgId, productId, warehouseId, delta, type, relatedPurchaseOrderId, relatedSalesOrderId, relatedProductionOrderId, relatedSaleId, note, actorEmail, lotNumber, expiryDate, lots, defaultLotNumber, session = null, idempotencyKey = null, allowNegative = null, unitCost = null }) {
  if (!MOVEMENT_TYPES.includes(type)) return { error: `Unknown movement type "${type}".`, status: 400 };
  if (!Number.isFinite(delta) || delta === 0) return { error: "delta must be a non-zero number.", status: 400 };
  if (allowNegative && String(allowNegative.reason || "").trim().length < 3) return { error: "A reason is required to allow negative stock.", status: 400 };
  try {
    return await withStockTransaction((s) => applyMovement({ orgId, productId, warehouseId, delta, type, relatedPurchaseOrderId, relatedSalesOrderId, relatedProductionOrderId, relatedSaleId, note, actorEmail, lotNumber, expiryDate, lots, defaultLotNumber, idempotencyKey, allowNegative, unitCost }, s), session);
  } catch (e) {
    if (e instanceof StockError && !session) return { error: e.message, status: e.status, code: e.code };
    throw e; // inside a caller's transaction the caller decides (and the whole transaction aborts)
  }
}

async function applyMovement(a, session) {
  const { stockLevels, stockMovements, stockLots, products } = await getOrgCollections();
  const o = { session };
  const orgObjectId = toObjectId(a.orgId);
  const productObjectId = toObjectId(a.productId);
  const warehouseObjectId = toObjectId(a.warehouseId);
  const key = { orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId };

  const idem = a.idempotencyKey ? String(a.idempotencyKey).slice(0, 200) : null;
  if (idem) {
    const prior = await stockMovements.findOne({ orgId: orgObjectId, idempotencyKey: idem }, o);
    if (prior) {
      const level = await stockLevels.findOne(key, o);
      return { movement: prior, newQuantity: level?.quantity ?? 0, lots: prior.lots, duplicate: true };
    }
  }

  const product = await products.findOne({ _id: productObjectId, orgId: orgObjectId }, { projection: { trackLots: 1, avgCost: 1, costPrice: 1, productType: 1 }, session });
  if (!product) throw new StockError("Product not found.", 404, "NOT_FOUND");
  const plan = await planLots({
    stockLots, orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId, delta: a.delta,
    trackLots: !!product.trackLots, lotNumber: a.lotNumber, expiryDate: a.expiryDate, lots: a.lots, defaultLotNumber: a.defaultLotNumber, session,
  });
  if (plan.error) throw new StockError(plan.error, plan.status || 400, "LOTS");

  let updatedLevel;
  if (a.delta < 0 && !a.allowNegative) {
    updatedLevel = await stockLevels.findOneAndUpdate({ ...key, quantity: { $gte: -a.delta } }, { $inc: { quantity: a.delta } }, { returnDocument: "after", session });
    if (!updatedLevel) {
      const current = await stockLevels.findOne(key, o);
      throw new StockError(`Not enough stock at this warehouse (have ${current?.quantity || 0}, tried to remove ${-a.delta}).`, 409, "INSUFFICIENT_STOCK");
    }
  } else {
    updatedLevel = await stockLevels.findOneAndUpdate(key, { $inc: { quantity: a.delta }, $setOnInsert: key }, { upsert: true, returnDocument: "after", session });
  }
  if (plan.lots) {
    try { await applyLots({ stockLots, orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId, sign: Math.sign(a.delta), lots: plan.lots, session, allowNegative: !!a.allowNegative }); }
    catch (e) { if (e?.isStockError) throw new StockError(e.message, e.status || 409, e.code || "INSUFFICIENT_LOT"); throw e; }
  }

  // Costing (Inaya Commerce, Batch 1): stock IN with a unit cost updates the moving-average cost (weighted by the stock
  // on hand across all warehouses before this movement); stock OUT records the cost at that moment for COGS.
  let costAtMovement = Number.isFinite(a.unitCost) ? a.unitCost : null;
  if (a.delta > 0 && Number.isFinite(a.unitCost) && ["RECEIPT", "PRODUCE", "RETURN"].includes(a.type)) {
    const levels = await stockLevels.find({ orgId: orgObjectId, productId: productObjectId }, { projection: { quantity: 1 }, session }).toArray();
    const onHandBefore = Math.max(0, levels.reduce((n, l) => n + l.quantity, 0) - a.delta);
    const prevAvg = Number.isFinite(product.avgCost) ? product.avgCost : null;
    const avg = prevAvg === null || onHandBefore === 0 ? a.unitCost : (onHandBefore * prevAvg + a.delta * a.unitCost) / (onHandBefore + a.delta);
    await products.updateOne({ _id: productObjectId, orgId: orgObjectId }, { $set: { avgCost: Math.round(avg * 10000) / 10000, ...(a.type === "RECEIPT" ? { lastPurchaseCost: a.unitCost } : {}), costUpdatedAt: new Date().toISOString() } }, { session });
  } else if (a.delta < 0 && costAtMovement === null) {
    costAtMovement = Number.isFinite(product.avgCost) ? product.avgCost : Number.isFinite(product.costPrice) ? product.costPrice : null;
  }

  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId, type: a.type, delta: a.delta,
    relatedPurchaseOrderId: a.relatedPurchaseOrderId ? toObjectId(a.relatedPurchaseOrderId) : null,
    ...(a.relatedSalesOrderId ? { relatedSalesOrderId: toObjectId(a.relatedSalesOrderId) } : {}),
    ...(a.relatedProductionOrderId ? { relatedProductionOrderId: toObjectId(a.relatedProductionOrderId) } : {}),
    ...(a.relatedSaleId ? { relatedSaleId: toObjectId(a.relatedSaleId) } : {}),
    ...(idem ? { idempotencyKey: idem } : {}),
    ...(a.allowNegative ? { override: { negativeAllowed: true, reason: String(a.allowNegative.reason).trim().slice(0, 300), by: a.actorEmail || null } } : {}),
    ...(costAtMovement !== null ? { unitCost: costAtMovement } : {}),
    note: a.note || null, lots: plan.lots, actorEmail: a.actorEmail, createdAt: now,
  };
  const result = await stockMovements.insertOne(doc, o);
  return { movement: { ...doc, _id: result.insertedId }, newQuantity: updatedLevel.quantity, lots: plan.lots };
}

/** Reconciliation (Master SOW 5.4 "administrative repair tools"): the ledger is the truth, stock_levels a cache of it.
 *  Compares every level with the sum of its movements and reports the differences; with repair=true it sets the level
 *  to the ledger sum in a transaction and records the correction in the activity log. Lots are compared with their
 *  level for lot-tracked products (report only). */
export async function reconcileStockLevels({ orgId, repair = false, actorEmail = "system" }) {
  const { stockLevels, stockMovements, stockLots, products } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const sums = await stockMovements.aggregate([{ $match: { orgId: orgObjectId } }, { $group: { _id: { p: "$productId", w: "$warehouseId" }, total: { $sum: "$delta" } } }]).toArray();
  const ledger = new Map(sums.map((x) => [`${x._id.p}:${x._id.w}`, x.total]));
  const levels = await stockLevels.find({ orgId: orgObjectId }).toArray();
  const seen = new Set(); const mismatches = [];
  for (const l of levels) {
    const k = `${l.productId}:${l.warehouseId}`; seen.add(k);
    const expected = Math.round((ledger.get(k) || 0) * 1e6) / 1e6;
    if (Math.abs(expected - l.quantity) > 1e-6) mismatches.push({ productId: String(l.productId), warehouseId: String(l.warehouseId), level: l.quantity, ledger: expected });
  }
  for (const [k, total] of ledger) if (!seen.has(k) && Math.abs(total) > 1e-6) { const [p, w] = k.split(":"); mismatches.push({ productId: p, warehouseId: w, level: 0, ledger: total, missingLevel: true }); }
  const lotted = await products.find({ orgId: orgObjectId, trackLots: true }, { projection: { _id: 1 } }).toArray();
  const lotIssues = [];
  for (const p of lotted) {
    for (const l of levels.filter((x) => String(x.productId) === String(p._id))) {
      const sum = (await stockLots.find({ orgId: orgObjectId, productId: p._id, warehouseId: l.warehouseId }).toArray()).reduce((s, x) => s + x.quantity, 0);
      if (Math.abs(sum - l.quantity) > 1e-6) lotIssues.push({ productId: String(p._id), warehouseId: String(l.warehouseId), level: l.quantity, lots: sum });
    }
  }
  let repaired = 0;
  if (repair && mismatches.length) {
    await withStockTransaction(async (session) => {
      for (const m of mismatches) {
        await stockLevels.updateOne({ orgId: orgObjectId, productId: toObjectId(m.productId), warehouseId: toObjectId(m.warehouseId) }, { $set: { quantity: m.ledger }, $setOnInsert: { orgId: orgObjectId, productId: toObjectId(m.productId), warehouseId: toObjectId(m.warehouseId) } }, { upsert: true, session });
        repaired++;
      }
    });
    await logOrgActivity({ orgId: orgObjectId, recordType: "STOCK_RECONCILIATION", recordId: orgObjectId, actorEmail, action: "STOCK_LEVELS_REPAIRED", previousState: null, newState: null, metadata: { repaired, mismatches: mismatches.slice(0, 50) } }).catch(() => {});
  }
  return { checked: levels.length, mismatches, lotIssues, repaired };
}

export async function getStockLevel(orgId, productId, warehouseId) {
  const { stockLevels } = await getOrgCollections();
  const level = await stockLevels.findOne({ orgId: toObjectId(orgId), productId: toObjectId(productId), warehouseId: toObjectId(warehouseId) });
  return level?.quantity || 0;
}

export async function listStockLevelsForProduct(orgId, productId) {
  const { stockLevels } = await getOrgCollections();
  return stockLevels.find({ orgId: toObjectId(orgId), productId: toObjectId(productId) }).toArray();
}

export async function totalStockForProduct(orgId, productId) {
  const levels = await listStockLevelsForProduct(orgId, productId);
  return levels.reduce((sum, l) => sum + l.quantity, 0);
}

export function isLowStock(product, totalQuantity) {
  return (product.reorderThreshold || 0) > 0 && totalQuantity <= product.reorderThreshold;
}

/** Business Workspace Remaining Features SOW — warehouse-to-warehouse
 *  transfer. A thin orchestration over recordStockMovement(), which
 *  already defines TRANSFER_IN/TRANSFER_OUT (unused until now) — no new
 *  stock-mutation primitive, just two calls to the existing one, linked
 *  by a shared transferId so history can group them. Rejects an
 *  identical source/destination up front; insufficient stock is rejected
 *  by the existing TRANSFER_OUT call itself (recordStockMovement's own
 *  negative-delta check), so this never invents a second stock-
 *  sufficiency check that could drift from the real one. */
export async function transferStock({ orgId, productId, sourceWarehouseId, destWarehouseId, quantity, note, actorEmail, lotNumber }) {
  if (sourceWarehouseId === destWarehouseId) return { error: "Source and destination warehouses must be different.", status: 400 };
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: "quantity must be a positive number.", status: 400 };

  const transferId = randomUUID();
  const label = note ? `${note} (transfer ${transferId})` : `transfer ${transferId}`;
  // Both legs in ONE transaction: stock can no longer leave the source without arriving at the destination.
  let outResult, inResult;
  try {
    await withStockTransaction(async (session) => {
      outResult = await recordStockMovement({ orgId, productId, warehouseId: sourceWarehouseId, delta: -quantity, type: "TRANSFER_OUT", note: label, actorEmail, lotNumber, session });
      // The same batches (with their expiry dates) arrive at the destination.
      inResult = await recordStockMovement({ orgId, productId, warehouseId: destWarehouseId, delta: quantity, type: "TRANSFER_IN", note: label, actorEmail, lots: outResult.lots || undefined, session });
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message, status: e.status, code: e.code };
    throw e;
  }

  await logOrgActivity({
    orgId: toObjectId(orgId), recordType: "STOCK_TRANSFER", recordId: outResult.movement._id, actorEmail,
    action: "STOCK_TRANSFERRED", previousState: null, newState: null,
    metadata: { transferId, productId, sourceWarehouseId, destWarehouseId, quantity },
  });

  return { transferId, from: outResult, to: inResult };
}
