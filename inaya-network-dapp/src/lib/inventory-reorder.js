// src/lib/inventory-reorder.js
//
// Business Workspace gap closure, Batch 1 — turn a low-stock signal into a
// DRAFT purchase request. A draft is never submitted on anyone's behalf: a
// person still reviews and submits it, and an owner/admin still approves it
// through the unchanged purchase-request workflow.
//
// "Already in flight" (no second draft): a request for this product that
// is DRAFT, PENDING_APPROVAL, or APPROVED without any purchase order raised
// from it having been fully RECEIVED yet. Once stock actually arrives (or
// the request is rejected/cancelled) a later low-stock reading can draft
// again.
//
// Products opt in to the daily automatic run with autoReorder (default off);
// the manual "draft reorder request" action works for any low-stock product.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { totalStockForProduct, isLowStock } from "./inventory.js";
import { notifyReorderDrafted } from "./business-notify.js";

const OPEN_STATES = ["DRAFT", "PENDING_APPROVAL", "APPROVED"];

/** The open reorder request for a product, or null. */
export async function findOpenReorderRequest(orgId, productId) {
  const { purchaseRequests, purchaseOrders } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requests = await purchaseRequests
    .find({ orgId: orgObjectId, reorderForProductId: toObjectId(productId), status: { $in: OPEN_STATES }, deletedAt: null })
    .sort({ createdAt: -1 })
    .toArray();
  for (const request of requests) {
    if (request.status !== "APPROVED") return request;
    const received = await purchaseOrders.findOne(
      { orgId: orgObjectId, sourceRequestId: request._id, status: "RECEIVED", deletedAt: null },
      { projection: { _id: 1 } }
    );
    if (!received) return request;
  }
  return null;
}

/** Suggested quantity: the product's reorderQuantity, else enough to reach
 *  twice the threshold. Always at least 1. */
export function suggestedReorderQuantity(product, currentStock) {
  if (Number.isFinite(product.reorderQuantity) && product.reorderQuantity > 0) return product.reorderQuantity;
  return Math.max(1, (product.reorderThreshold || 0) * 2 - currentStock);
}

/** Creates a DRAFT purchase request for a low-stock product. Returns
 *  { request, created } (created:false when one is already in flight) or
 *  { error, status }. */
export async function draftReorderRequest({ orgId, productId, actorEmail, source = "manual", sender }) {
  const { products, purchaseRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const product = await products.findOne({ _id: toObjectId(productId), orgId: orgObjectId, deletedAt: null });
  if (!product) return { error: "Product not found.", status: 404 };
  if (product.status && product.status !== "ACTIVE") return { error: "Only active products can be reordered.", status: 409 };

  const currentStock = await totalStockForProduct(orgId, productId);
  if (!isLowStock(product, currentStock)) {
    return { error: `Stock (${currentStock}) is above the reorder threshold (${product.reorderThreshold || 0}).`, status: 409 };
  }

  const existing = await findOpenReorderRequest(orgId, productId);
  if (existing) return { request: existing, created: false };

  const quantity = suggestedReorderQuantity(product, currentStock);
  const unitPrice = Number.isFinite(product.unitPrice) ? product.unitPrice : null;
  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId,
    departmentId: product.departmentId,
    supplierId: null,
    title: `Reorder: ${product.sku} — ${product.name}`,
    description: `Stock is ${currentStock}, at or below the reorder threshold of ${product.reorderThreshold}. Suggested quantity: ${quantity}.`,
    estimatedCost: unitPrice !== null ? Math.round(unitPrice * quantity * 100) / 100 : null,
    status: "DRAFT",
    reorderForProductId: product._id,
    reorderQuantity: quantity,
    reorderSource: source,
    createdByEmail: actorEmail,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const result = await purchaseRequests.insertOne(doc);
  const request = { ...doc, _id: result.insertedId };

  await logOrgActivity({
    orgId: orgObjectId, recordType: "PURCHASE_REQUEST", recordId: result.insertedId, actorEmail,
    action: "REORDER_DRAFTED", previousState: null, newState: "DRAFT",
    metadata: { productId: product._id.toString(), sku: product.sku, currentStock, quantity, source },
  });
  await notifyReorderDrafted({ orgId, product, requestId: result.insertedId, departmentId: product.departmentId, sender });

  return { request, created: true };
}

/** Daily job: drafts a reorder for every opted-in, active, low-stock
 *  product that doesn't already have one in flight. */
export async function runAutoReorder({ limit = 1000, sender, orgIds } = {}) {
  const { products } = await getOrgCollections();
  const candidates = await products.find({ ...(orgIds ? { orgId: { $in: orgIds.map((id) => toObjectId(id)) } } : {}), autoReorder: true, reorderThreshold: { $gt: 0 }, status: "ACTIVE", deletedAt: null }).limit(limit).toArray();
  let drafted = 0;
  let skipped = 0;
  let failed = 0;
  for (const product of candidates) {
    try {
      const orgId = product.orgId.toString();
      const stock = await totalStockForProduct(orgId, product._id);
      if (!isLowStock(product, stock)) { skipped++; continue; }
      const result = await draftReorderRequest({ orgId, productId: product._id.toString(), actorEmail: "system:auto-reorder", source: "auto", sender });
      if (result.created) drafted++;
      else skipped++;
    } catch (err) {
      failed++;
      console.error(`auto-reorder failed for product ${product._id}:`, err.message);
    }
  }
  return { scanned: candidates.length, drafted, skipped, failed };
}
