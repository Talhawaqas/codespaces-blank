// src/lib/purchase-order-totals.js
//
// One place that turns a purchase order into money figures, shared by the
// serializers, reports, the supplier email and the UI. Tax and shipping are
// optional (Batch 1 gap closure): a PO without them totals exactly what it
// always did — the sum of quantity × unitPrice.

const round2 = (n) => Math.round(n * 100) / 100;

export function computePoTotals(po) {
  const subtotal = round2((po.items || []).reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0));
  const taxRate = Number.isFinite(po.taxRate) ? po.taxRate : 0;
  const taxAmount = round2(subtotal * taxRate / 100);
  const shippingCost = Number.isFinite(po.shippingCost) ? round2(po.shippingCost) : 0;
  return { subtotal, taxRate, taxAmount, shippingCost, total: round2(subtotal + taxAmount + shippingCost) };
}

/** Validates the optional PO fields. Returns { fields } (only the keys that
 *  were provided) or { error }. */
export function validatePoExtras({ expectedDeliveryDate, taxRate, shippingCost }) {
  const fields = {};
  if (expectedDeliveryDate !== undefined) {
    if (expectedDeliveryDate === null || expectedDeliveryDate === "") fields.expectedDeliveryDate = null;
    else if (Number.isNaN(new Date(expectedDeliveryDate).getTime())) return { error: "expectedDeliveryDate must be a valid date." };
    else fields.expectedDeliveryDate = String(expectedDeliveryDate).slice(0, 10);
  }
  if (taxRate !== undefined) {
    if (taxRate === null || taxRate === "") fields.taxRate = null;
    else if (!Number.isFinite(Number(taxRate)) || Number(taxRate) < 0 || Number(taxRate) > 100) return { error: "taxRate must be a percentage from 0 to 100." };
    else fields.taxRate = Number(taxRate);
  }
  if (shippingCost !== undefined) {
    if (shippingCost === null || shippingCost === "") fields.shippingCost = null;
    else if (!Number.isFinite(Number(shippingCost)) || Number(shippingCost) < 0) return { error: "shippingCost must be zero or more." };
    else fields.shippingCost = Number(shippingCost);
  }
  return { fields };
}
