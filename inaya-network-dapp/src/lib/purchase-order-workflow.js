// src/lib/purchase-order-workflow.js
//
// Purchase order lifecycle — the 8-state machine from the Business
// Operations plan: DRAFT -> PENDING_APPROVAL -> APPROVED -> ORDERED ->
// PARTIALLY_RECEIVED/RECEIVED, plus REJECTED and CANCELLED. Every simple
// (non-quantity-bearing) transition goes through transitionPurchaseOrder(),
// the same {from,to,requiresManage,activityAction} table pattern as
// document-workflow.js/purchase-request-workflow.js. "approve"/"reject"
// are the only requiresManage:true transitions here — that's a deliberate
// simplification over a dedicated canApprovePurchases capability flag
// (the plan's other option): zero new surface, consistent with every
// other approval gate this codebase already has, revisit only if a real
// need for non-owner/admin approvers shows up.
//
// "receive" is NOT in that table — it carries a quantity payload per line
// item, not a fixed target status, so it's its own function,
// receivePurchaseOrder(). This is also where a received line item linked
// to a real product+warehouse (productId/warehouseId set at PO creation)
// triggers a real inventory.js stock movement — closing the gap the
// original phased plan explicitly flagged and accepted for one release
// cycle, now that Inventory (Phase 4) ships in the same pass as this.

import { getOrgCollections, canAccessDepartment, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { recordStockMovement } from "./inventory.js";

export const PURCHASE_ORDER_STATES = [
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "REJECTED", "CANCELLED",
];

export const PO_TRANSITIONS = {
  submit: { from: "DRAFT", to: "PENDING_APPROVAL", requiresManage: false, activityAction: "PO_SUBMITTED" },
  approve: { from: "PENDING_APPROVAL", to: "APPROVED", requiresManage: true, activityAction: "PO_APPROVED" },
  reject: { from: "PENDING_APPROVAL", to: "REJECTED", requiresManage: true, activityAction: "PO_REJECTED" },
  order: { from: "APPROVED", to: "ORDERED", requiresManage: false, activityAction: "PO_ORDERED" },
  cancel: { from: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED"], to: "CANCELLED", requiresManage: false, activityAction: "PO_CANCELLED" },
};

export async function transitionPurchaseOrder({ orgId, poId, action, membership, actorEmail, note }) {
  const definition = PO_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { purchaseOrders } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const poObjectId = toObjectId(poId);

  const po = await purchaseOrders.findOne({ _id: poObjectId, orgId: orgObjectId, deletedAt: null });
  if (!po) return { error: "Purchase order not found.", status: 404 };
  if (!canAccessDepartment(membership, po.departmentId)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }
  if (definition.requiresManage && !canManageOrg(membership)) {
    return { error: "Only the owner or an admin can do that.", status: 403 };
  }

  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const now = new Date().toISOString();

  const updated = await purchaseOrders.findOneAndUpdate(
    { _id: poObjectId, orgId: orgObjectId, status: fromFilter },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This purchase order isn't in ${expected} state (it's currently ${po.status}), so "${action}" can't be applied.`, status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "PURCHASE_ORDER",
    recordId: poObjectId,
    actorEmail,
    action: definition.activityAction,
    previousState: Array.isArray(definition.from) ? po.status : definition.from,
    newState: definition.to,
    metadata: note ? { note } : {},
  });

  return { po: updated };
}

/** Records partial or full receipt of a PO's line items. `receipts` is
 *  [{itemIndex, quantity}] — quantity received IN THIS CALL, added to
 *  that item's running receivedQuantity (not a replacement value, so
 *  repeated partial deliveries accumulate correctly). Only valid from
 *  ORDERED or PARTIALLY_RECEIVED. The resulting status is derived, not
 *  chosen by the caller: RECEIVED once every item's receivedQuantity
 *  reaches its ordered quantity, PARTIALLY_RECEIVED otherwise — so a
 *  client can never "receive" a PO into RECEIVED while items are still
 *  outstanding just by asserting that action name. */
export async function receivePurchaseOrder({ orgId, poId, receipts, membership, actorEmail, note }) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { error: "At least one item receipt is required.", status: 400 };
  }

  const { purchaseOrders } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const poObjectId = toObjectId(poId);

  const po = await purchaseOrders.findOne({ _id: poObjectId, orgId: orgObjectId, deletedAt: null });
  if (!po) return { error: "Purchase order not found.", status: 404 };
  if (!canAccessDepartment(membership, po.departmentId)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }
  if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status)) {
    return { error: `This purchase order isn't in ORDERED/PARTIALLY_RECEIVED state (it's currently ${po.status}), so items can't be received.`, status: 409 };
  }

  const items = po.items.map((item) => ({ ...item }));
  for (const { itemIndex, quantity } of receipts) {
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length) {
      return { error: `Invalid item index ${itemIndex}.`, status: 400 };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { error: "Each receipt quantity must be a positive number.", status: 400 };
    }
    const item = items[itemIndex];
    const alreadyReceived = item.receivedQuantity || 0;
    if (alreadyReceived + quantity > item.quantity) {
      return { error: `Receiving ${quantity} of "${item.description}" would exceed its ordered quantity (${item.quantity}, already received ${alreadyReceived}).`, status: 409 };
    }
  }

  // All validated against the snapshot read above — compute the target
  // items/status, then win the optimistic-concurrency race BEFORE
  // touching real inventory. Ordering matters: if stock movements were
  // applied first and this update then lost a race to a concurrent
  // receive call, the losing call's movements would already be posted
  // with no PO state to show for them — a real double-count. Guarding
  // first means a losing call's 409 leaves inventory untouched.
  for (const { itemIndex, quantity } of receipts) {
    items[itemIndex].receivedQuantity = (items[itemIndex].receivedQuantity || 0) + quantity;
  }
  const fullyReceived = items.every((item) => (item.receivedQuantity || 0) >= item.quantity);
  const newStatus = fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
  const now = new Date().toISOString();

  const updated = await purchaseOrders.findOneAndUpdate(
    { _id: poObjectId, orgId: orgObjectId, status: po.status },
    { $set: { items, status: newStatus, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    return { error: "This purchase order changed since it was loaded — reload and try again.", status: 409 };
  }

  for (const { itemIndex, quantity } of receipts) {
    const item = items[itemIndex];
    if (item.productId && item.warehouseId) {
      await recordStockMovement({
        orgId, productId: item.productId, warehouseId: item.warehouseId, delta: quantity,
        type: "RECEIPT", relatedPurchaseOrderId: poId, note: `PO receipt: ${item.description}`, actorEmail,
      });
    }
  }

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "PURCHASE_ORDER",
    recordId: poObjectId,
    actorEmail,
    action: fullyReceived ? "PO_RECEIVED" : "PO_PARTIALLY_RECEIVED",
    previousState: po.status,
    newState: newStatus,
    metadata: note ? { note, receipts } : { receipts },
  });

  return { po: updated };
}
