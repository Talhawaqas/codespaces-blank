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

import { getOrgCollections, toObjectId } from "./orgs.js";

export const MOVEMENT_TYPES = ["RECEIPT", "ISSUE", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT"];

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
export async function recordStockMovement({ orgId, productId, warehouseId, delta, type, relatedPurchaseOrderId, note, actorEmail }) {
  if (!MOVEMENT_TYPES.includes(type)) return { error: `Unknown movement type "${type}".`, status: 400 };
  if (!Number.isFinite(delta) || delta === 0) return { error: "delta must be a non-zero number.", status: 400 };

  const { stockLevels, stockMovements } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const productObjectId = toObjectId(productId);
  const warehouseObjectId = toObjectId(warehouseId);

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

  const now = new Date().toISOString();
  const result = await stockMovements.insertOne({
    orgId: orgObjectId,
    productId: productObjectId,
    warehouseId: warehouseObjectId,
    type,
    delta,
    relatedPurchaseOrderId: relatedPurchaseOrderId ? toObjectId(relatedPurchaseOrderId) : null,
    note: note || null,
    actorEmail,
    createdAt: now,
  });

  return { movement: { _id: result.insertedId, orgId: orgObjectId, productId: productObjectId, warehouseId: warehouseObjectId, type, delta, createdAt: now }, newQuantity: updatedLevel.quantity };
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
