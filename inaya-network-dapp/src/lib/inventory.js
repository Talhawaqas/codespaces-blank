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
export const MOVEMENT_TYPES = ["RECEIPT", "ISSUE", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT", "CONSUME", "PRODUCE"];

/** Applies a signed stock change and records the movement that caused it,
 *  in that order — insertOne's own ordering guarantee doesn't matter here
 *  since neither write is conditional on the other having succeeded; if
 *  the process dies between them, stock_levels is very slightly ahead of
 *  its own ledger until the next real movement reconciles it, which is
 *  the accepted trade-off of not wrapping both in a transaction for a
 *  single-node MongoDB deployment. Negative deltas are checked against
 *  current stock first (best-effort, not perfectly race-free under
 *  concurrent issues from the same product+warehouse — the same
 *  known-and-accepted trade-off as everywhere else in this codebase that
 *  doesn't reach for a distributed lock over a low-contention path). */
//
// Batch / lot tracking (inventory-lots.js): lotNumber + expiryDate name the
// lot a movement touches, or `lots` lists several explicitly (a transfer's
// IN leg reuses the OUT leg's lots). For a trackLots product a stock-out
// without a lot is allocated earliest-expiry-first, and defaultLotNumber is
// used for a stock-in that names none (PO receipts pass the PO's number).
export async function recordStockMovement({ orgId, productId, warehouseId, delta, type, relatedPurchaseOrderId, relatedSalesOrderId, relatedProductionOrderId, note, actorEmail, lotNumber, expiryDate, lots, defaultLotNumber }) {
  if (!MOVEMENT_TYPES.includes(type)) return { error: `Unknown movement type "${type}".`, status: 400 };
  if (!Number.isFinite(delta) || delta === 0) return { error: "delta must be a non-zero number.", status: 400 };

  const { stockLevels, stockMovements, stockLots, products } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const productObjectId = toObjectId(productId);
  const warehouseObjectId = toObjectId(warehouseId);

  const product = await products.findOne({ _id: productObjectId, orgId: orgObjectId }, { projection: { trackLots: 1 } });
  const plan = await planLots({
    stockLots, orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId, delta,
    trackLots: !!product?.trackLots, lotNumber, expiryDate, lots, defaultLotNumber,
  });
  if (plan.error) return plan;

  if (delta < 0) {
    const current = await stockLevels.findOne({ orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId });
    if (!current || current.quantity + delta < 0) {
      return { error: `Not enough stock at this warehouse (have ${current?.quantity || 0}, tried to remove ${-delta}).`, status: 409 };
    }
  }

  const updatedLevel = await stockLevels.findOneAndUpdate(
    { orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId },
    { $inc: { quantity: delta }, $setOnInsert: { orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId } },
    { upsert: true, returnDocument: "after" }
  );
  if (plan.lots) await applyLots({ stockLots, orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId, sign: Math.sign(delta), lots: plan.lots });

  const now = new Date().toISOString();
  const result = await stockMovements.insertOne({
    orgId: orgObjectId,
    productId: productObjectId,
    warehouseId: warehouseObjectId,
    type,
    delta,
    relatedPurchaseOrderId: relatedPurchaseOrderId ? toObjectId(relatedPurchaseOrderId) : null,
    ...(relatedSalesOrderId ? { relatedSalesOrderId: toObjectId(relatedSalesOrderId) } : {}),
    ...(relatedProductionOrderId ? { relatedProductionOrderId: toObjectId(relatedProductionOrderId) } : {}),
    note: note || null,
    lots: plan.lots,
    actorEmail,
    createdAt: now,
  });

  return { movement: { _id: result.insertedId, orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId, type, delta, lots: plan.lots, createdAt: now }, newQuantity: updatedLevel.quantity, lots: plan.lots };
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
  const outResult = await recordStockMovement({ orgId, productId, warehouseId: sourceWarehouseId, delta: -quantity, type: "TRANSFER_OUT", note: note ? `${note} (transfer ${transferId})` : `transfer ${transferId}`, actorEmail, lotNumber });
  if (outResult.error) return outResult;

  // The same batches (with their expiry dates) arrive at the destination.
  const inResult = await recordStockMovement({ orgId, productId, warehouseId: destWarehouseId, delta: quantity, type: "TRANSFER_IN", note: note ? `${note} (transfer ${transferId})` : `transfer ${transferId}`, actorEmail, lots: outResult.lots || undefined });
  if (inResult.error) {
    // The OUT leg already committed -- reverse it rather than leaving
    // stock silently vanished. A real, recorded reversal movement, not a
    // silent undo, so the ledger stays a true append-only history.
    await recordStockMovement({ orgId, productId, warehouseId: sourceWarehouseId, delta: quantity, type: "ADJUSTMENT", note: `reversal of failed transfer ${transferId}: ${inResult.error}`, actorEmail, lots: outResult.lots || undefined });
    return inResult;
  }

  await logOrgActivity({
    orgId: toObjectId(orgId), recordType: "STOCK_TRANSFER", recordId: outResult.movement._id, actorEmail,
    action: "STOCK_TRANSFERRED", previousState: null, newState: null,
    metadata: { transferId, productId, sourceWarehouseId, destWarehouseId, quantity },
  });

  return { transferId, from: outResult, to: inResult };
}
