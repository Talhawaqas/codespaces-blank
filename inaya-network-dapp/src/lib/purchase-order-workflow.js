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
import { normalizeExpiryDate } from "./inventory-lots.js";
import { applyPurchaseUnits, stockUnitsFor } from "./inventory-units.js";

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

/** Business Workspace Remaining Features SOW — line-item editing after
 *  creation. Allowed ONLY while DRAFT: the one state nothing has acted on
 *  yet (no approval, no ordering, no receiving) — the safest, most
 *  defensible reading of "prevent editing of restricted/closed POs."
 *  Validates each item the same way the create route does (not a
 *  separate, divergent validator), replaces the items array atomically,
 *  and logs the before/after item count + total as the audit trail —
 *  there is no stored `total` field on a PO (it's derived on read, same
 *  as the create route), so nothing else needs recomputing server-side. */
export async function updatePurchaseOrderItems({ orgId, poId, items, membership, actorEmail }) {
  if (!Array.isArray(items) || items.length === 0) return { error: "At least one line item is required.", status: 400 };
  const cleanItems = [];
  for (const raw of items) {
    const description = String(raw?.description || "").trim();
    if (!description) return { error: "Every line item needs a description.", status: 400 };
    const quantity = Number(raw?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `Invalid quantity for "${description}".`, status: 400 };
    const unitPrice = raw?.unitPrice === undefined || raw?.unitPrice === null ? null : Number(raw.unitPrice);
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) return { error: `Invalid unit price for "${description}".`, status: 400 };
    cleanItems.push({
      description, sku: raw?.sku ? String(raw.sku).trim() : null,
      productId: raw?.productId ? toObjectId(raw.productId) : null,
      warehouseId: raw?.warehouseId ? toObjectId(raw.warehouseId) : null,
      quantity, unitPrice, receivedQuantity: 0,
    });
  }

  await applyPurchaseUnits(orgId, cleanItems);

  const { purchaseOrders } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const poObjectId = toObjectId(poId);

  const existing = await purchaseOrders.findOne({ _id: poObjectId, orgId: orgObjectId, deletedAt: null });
  if (!existing) return { error: "Purchase order not found.", status: 404 };
  if (!canAccessDepartment(membership, existing.departmentId)) return { error: "You don't have permission to do that.", status: 403 };

  const now = new Date().toISOString();
  const updated = await purchaseOrders.findOneAndUpdate(
    { _id: poObjectId, orgId: orgObjectId, status: "DRAFT" },
    { $set: { items: cleanItems, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: `This purchase order isn't in DRAFT state (it's currently ${existing.status}), so its line items can't be edited.`, status: 409 };

  const oldTotal = existing.items.reduce((s, i) => s + i.quantity * (i.unitPrice || 0), 0);
  const newTotal = cleanItems.reduce((s, i) => s + i.quantity * (i.unitPrice || 0), 0);
  await logOrgActivity({
    orgId: orgObjectId, recordType: "PURCHASE_ORDER", recordId: poObjectId, actorEmail,
    action: "PO_ITEMS_EDITED", previousState: `${existing.items.length} items, ${oldTotal.toFixed(2)}`,
    newState: `${cleanItems.length} items, ${newTotal.toFixed(2)}`, metadata: {},
  });

  return { po: updated };
}

export async function transitionPurchaseOrder({ orgId, poId, action, membership, actorEmail, note }) {
  if (action === "approve") return approvePurchaseOrder({ orgId, poId, membership, actorEmail, note });
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
    { $set: { status: definition.to, updatedAt: now, ...(action === "order" ? { orderedAt: now } : {}) } },
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

/** Approval in levels (Inaya Commerce Phase 3, Master SOW 7.8): the company's thresholds decide how many approvals a PO
 *  needs (default: one owner/admin, the long-standing behaviour). Each level needs a different person, and an "owner"
 *  level needs the owner. The PO becomes APPROVED when the last level approves. */
export async function approvePurchaseOrder({ orgId, poId, membership, actorEmail, note }) {
  const { purchaseOrders } = await getOrgCollections();
  const po = await purchaseOrders.findOne({ _id: toObjectId(poId), orgId: toObjectId(orgId), deletedAt: null });
  if (!po) return { error: "Purchase order not found.", status: 404 };
  if (!canAccessDepartment(membership, po.departmentId)) return { error: "You don't have permission to do that.", status: 403 };
  if (po.status !== "PENDING_APPROVAL") return { error: `This purchase order isn't in PENDING_APPROVAL state (it's currently ${po.status}), so "approve" can't be applied.`, status: 409 };
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can do that.", status: 403 };
  const { requiredPoApprovals } = await import("./stock-control/purchasing.js");
  const need = await requiredPoApprovals(orgId, po);
  const done = po.approvals || []; const level = need.levels[done.length];
  if (!level) return { error: "This purchase order already has every approval it needs.", status: 409 };
  if (done.some((a) => a.by === actorEmail)) return { error: `This order (${need.currency} ${need.value}) needs ${need.levels.length} approvals from different people; you have already approved it.`, status: 403, code: "SECOND_APPROVER" };
  if (level.role === "owner" && membership?.role !== "owner") return { error: `Orders above ${need.currency} ${level.above} need the owner's approval.`, status: 403, code: "OWNER_APPROVAL" };
  const now = new Date().toISOString(); const last = done.length + 1 === need.levels.length;
  const updated = await purchaseOrders.findOneAndUpdate({ _id: po._id, status: "PENDING_APPROVAL", [`approvals.${done.length}`]: { $exists: false } },
    { $push: { approvals: { level: done.length + 1, role: level.role, by: actorEmail, at: now, value: need.value, currency: need.currency } }, $set: { ...(last ? { status: "APPROVED" } : {}), updatedAt: now } }, { returnDocument: "after" });
  if (!updated) return { error: "This purchase order changed since it was loaded — reload and try again.", status: 409 };
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "PURCHASE_ORDER", recordId: po._id, actorEmail, action: last ? "PO_APPROVED" : "PO_APPROVAL_LEVEL", previousState: "PENDING_APPROVAL", newState: updated.status, metadata: { level: done.length + 1, of: need.levels.length, value: need.value, currency: need.currency, ...(note ? { note } : {}) } });
  return { po: updated, approvalsNeeded: need.levels.length, approvalsDone: done.length + 1 };
}

/** Records partial or full receipt of a PO's line items. `receipts` is
 *  [{itemIndex, quantity, lotNumber?, expiryDate?}] — quantity received IN THIS CALL, added to
 *  that item's running receivedQuantity (not a replacement value, so
 *  repeated partial deliveries accumulate correctly). Only valid from
 *  ORDERED or PARTIALLY_RECEIVED. The resulting status is derived, not
 *  chosen by the caller: RECEIVED once every item's receivedQuantity
 *  reaches its ordered quantity, PARTIALLY_RECEIVED otherwise — so a
 *  client can never "receive" a PO into RECEIVED while items are still
 *  outstanding just by asserting that action name. */
// Receiving extensions (Phase 3, Master SOW 7.9): per line `damaged` (not accepted; held in the quarantine location when
// `toQuarantine`, ready for a supplier return), an over-receipt allowance (stock settings), `discrepancies`
// ([{ type: SHORT|WRONG_ITEM|DAMAGED|OTHER, itemIndex?, note }]) and a `packingSlipDocumentId`; every receipt is
// kept in po.receipts[], received goods carry their landed cost, and the supplier's actual lead time is recorded.
export async function receivePurchaseOrder({ orgId, poId, receipts, membership, actorEmail, note, discrepancies = [], packingSlipDocumentId = null }) {
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
  const { getStockSettings, allocateLanded, KINDS: SC } = await import("./stock-control/purchasing.js");
  const overPct = (await getStockSettings(orgId)).overReceiptPercent || 0;
  for (const { itemIndex, quantity: q0, damaged, expiryDate } of receipts) {
    const quantity = q0 === 0 && Number(damaged) > 0 ? null : q0;
    if (quantity === null) { if (!Number.isInteger(itemIndex) || !items[itemIndex]) return { error: `Invalid item index ${itemIndex}.`, status: 400 }; continue; }
    if (normalizeExpiryDate(expiryDate)?.error) return { error: "Expiry date must be a date (YYYY-MM-DD).", status: 400 };
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length) {
      return { error: `Invalid item index ${itemIndex}.`, status: 400 };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { error: "Each receipt quantity must be a positive number.", status: 400 };
    }
    const item = items[itemIndex];
    const alreadyReceived = item.receivedQuantity || 0;
    if (alreadyReceived + quantity > item.quantity * (1 + overPct / 100) + 1e-9) {
      return { error: `Receiving ${quantity} of "${item.description}" would exceed its ordered quantity (${item.quantity}, already received ${alreadyReceived}${overPct ? `, allowance ${overPct}%` : ""}).`, status: 409 };
    }
  }

  // All validated against the snapshot read above — compute the target
  // items/status, then win the optimistic-concurrency race BEFORE
  // touching real inventory. Ordering matters: if stock movements were
  // applied first and this update then lost a race to a concurrent
  // receive call, the losing call's movements would already be posted
  // with no PO state to show for them — a real double-count. Guarding
  // first means a losing call's 409 leaves inventory untouched.
  for (const { itemIndex, quantity, damaged } of receipts) {
    items[itemIndex].receivedQuantity = (items[itemIndex].receivedQuantity || 0) + (quantity || 0);
    if (Number(damaged) > 0) items[itemIndex].damagedQuantity = (items[itemIndex].damagedQuantity || 0) + Number(damaged);
  }
  const receiptRecord = { no: (po.receipts || []).length + 1, at: new Date().toISOString(), by: actorEmail, lines: receipts.map((r) => ({ itemIndex: r.itemIndex, received: r.quantity || 0, damaged: Number(r.damaged) || 0, toQuarantine: !!r.toQuarantine, lotNumber: r.lotNumber || null })),
    discrepancies: (Array.isArray(discrepancies) ? discrepancies : []).slice(0, 50).map((d) => ({ type: ["SHORT", "WRONG_ITEM", "DAMAGED", "OTHER"].includes(d.type) ? d.type : "OTHER", itemIndex: Number.isInteger(d.itemIndex) ? d.itemIndex : null, note: String(d.note || "").slice(0, 300) })),
    packingSlipDocumentId: packingSlipDocumentId ? String(packingSlipDocumentId) : null, note: note || null };
  const fullyReceived = items.every((item) => (item.receivedQuantity || 0) >= item.quantity);
  const newStatus = fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
  const now = new Date().toISOString();

  const updated = await purchaseOrders.findOneAndUpdate(
    { _id: poObjectId, orgId: orgObjectId, status: po.status },
    { $set: { items, status: newStatus, updatedAt: now }, $push: { receipts: receiptRecord } },
    { returnDocument: "after" }
  );
  if (!updated) {
    return { error: "This purchase order changed since it was loaded — reload and try again.", status: 409 };
  }
  const landedPer = allocateLanded(po);

  // Costing (Inaya Commerce): each stock unit received carries its purchase cost in the company's selling currency,
  // which keeps the product's moving-average cost (and so COGS and margins) honest.
  const { getSettings } = await import("./commerce/store.js");
  const { convert } = await import("./currency.js");
  const sellCurrency = (await getSettings(orgId).catch(() => null))?.currency || null;
  const unitCostOf = (item, idx = null) => {
    const per = (Number(item.unitPrice) + (idx !== null ? landedPer[idx] || 0 : 0)) / (Number(item.unitsPerPurchaseUnit) > 0 ? Number(item.unitsPerPurchaseUnit) : 1);
    if (!Number.isFinite(per) || per < 0) return null;
    const from = po.currency || "USD"; if (!sellCurrency || !from || from === sellCurrency) return Math.round(per * 10000) / 10000;
    const c = convert(per, from, sellCurrency); return Number.isFinite(c?.convertedAmount) ? Math.round(per * c.rate * 10000) / 10000 : null;
  };
  const { getSettings: commerceSettings } = await import("./commerce/store.js");
  const quarantine = (await commerceSettings(orgId).catch(() => ({}))).quarantineWarehouseId || null;
  for (const { itemIndex, quantity, damaged, toQuarantine, lotNumber, expiryDate } of receipts) {
    const item = items[itemIndex];
    if (Number(damaged) > 0 && toQuarantine && item.productId && quarantine) {
      await recordStockMovement({ unitCost: unitCostOf(item, itemIndex) ?? undefined, orgId, productId: item.productId, warehouseId: quarantine, delta: stockUnitsFor(item, Number(damaged)), type: "RECEIPT", relatedPurchaseOrderId: poId, lotNumber, expiryDate, defaultLotNumber: `PO-${String(poId).slice(-6).toUpperCase()}`, reason: "Damaged on arrival: held for supplier return", note: `PO receipt (damaged, quarantined): ${item.description}`, actorEmail, idempotencyKey: `po:${poId}:r${receiptRecord.no}:${itemIndex}:q` });
    }
    if (!quantity) continue;
    if (item.productId && item.warehouseId) {
      await recordStockMovement({ unitCost: unitCostOf(item, itemIndex) ?? undefined, idempotencyKey: `po:${poId}:r${receiptRecord.no}:${itemIndex}`,
        orgId, productId: item.productId, warehouseId: item.warehouseId, delta: stockUnitsFor(item, quantity),
        type: "RECEIPT", relatedPurchaseOrderId: poId, lotNumber, expiryDate, defaultLotNumber: `PO-${String(poId).slice(-6).toUpperCase()}`, note: item.unitsPerPurchaseUnit > 1 ? `PO receipt: ${item.description} (${quantity} ${item.unit} × ${item.unitsPerPurchaseUnit})` : `PO receipt: ${item.description}`, actorEmail,
      });
    }
  }

  // supplier lead time actually achieved (first receipt of each product on this PO)
  if (po.orderedAt) {
    const days = Math.max(0, Math.round((Date.now() - Date.parse(po.orderedAt)) / 86400000));
    const { ccol } = await import("./commerce/store.js"); const c = await ccol();
    for (const { itemIndex, quantity } of receipts) {
      const item = po.items[itemIndex]; if (!quantity || !item.productId || (item.receivedQuantity || 0) > 0) continue;
      await c.updateOne({ orgId: orgObjectId, kind: SC.supplierItem, supplierId: po.supplierId, productId: toObjectId(item.productId), "leadTimeHistory.poId": { $ne: String(poId) } }, { $push: { leadTimeHistory: { poId: String(poId), days, at: new Date().toISOString() } } }).catch(() => {});
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
