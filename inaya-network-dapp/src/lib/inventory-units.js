// src/lib/inventory-units.js
//
// Business Workspace gap closure, Batch 3 — barcodes and units of measure.
//
// A product can carry an optional barcode (unique per org when set), the
// unit its stock is counted in (default "each"), and optionally the unit it
// is bought in plus a conversion ("box" of 12). A purchase order line for
// such a product snapshots the conversion when the line is written, so
// receiving 3 boxes adds 36 to stock — and changing the product later never
// rewrites an existing PO. Products without these fields behave exactly as
// before (1 ordered = 1 in stock).

import { getOrgCollections, toObjectId } from "./orgs.js";

export const DEFAULT_UNIT = "each";
const UNIT = /^[\p{L}\p{N} ._/-]{1,20}$/u;
const BARCODE = /^[A-Za-z0-9\-. ]{4,64}$/;

/** Validates the optional unit/barcode fields of a product create/patch body.
 *  Returns { fields } (only the keys that were present) or { error }. */
export function validateUnitFields(body = {}, { existing = null } = {}) {
  const fields = {};
  if (body.barcode !== undefined) {
    if (body.barcode === null || body.barcode === "") fields.barcode = null;
    else {
      const b = String(body.barcode).trim();
      if (!BARCODE.test(b)) return { error: "Barcode must be 4-64 letters, digits, dashes, dots or spaces." };
      fields.barcode = b;
    }
  }
  if (body.unit !== undefined) {
    const u = body.unit === null || body.unit === "" ? DEFAULT_UNIT : String(body.unit).trim().toLowerCase();
    if (!UNIT.test(u)) return { error: "Unit must be 1-20 characters, e.g. each, kg, box." };
    fields.unit = u;
  }
  if (body.purchaseUnit !== undefined || body.unitsPerPurchaseUnit !== undefined) {
    const pu = body.purchaseUnit === undefined ? existing?.purchaseUnit ?? null : body.purchaseUnit;
    const per = body.unitsPerPurchaseUnit === undefined ? existing?.unitsPerPurchaseUnit ?? null : body.unitsPerPurchaseUnit;
    if (pu === null || pu === "") {
      fields.purchaseUnit = null; fields.unitsPerPurchaseUnit = null;
    } else {
      const p = String(pu).trim().toLowerCase();
      if (!UNIT.test(p)) return { error: "Purchase unit must be 1-20 characters, e.g. box, case." };
      if (!Number.isInteger(per) || per < 2 || per > 100000) return { error: "Units per purchase unit must be a whole number from 2 to 100000." };
      fields.purchaseUnit = p; fields.unitsPerPurchaseUnit = per;
    }
  }
  return { fields };
}

/** How many stock units a received purchase-order quantity represents. */
export function stockUnitsFor(item, quantity) {
  const per = Number(item?.unitsPerPurchaseUnit);
  return Number.isInteger(per) && per > 1 ? quantity * per : quantity;
}

/** Snapshots each product's purchase unit onto its PO lines (mutates and returns items). */
export async function applyPurchaseUnits(orgId, items) {
  const ids = [...new Set(items.filter((i) => i.productId).map((i) => String(i.productId)))];
  if (!ids.length) return items;
  const { products } = await getOrgCollections();
  const found = await products.find({ _id: { $in: ids.map(toObjectId) }, orgId: toObjectId(orgId) }, { projection: { purchaseUnit: 1, unitsPerPurchaseUnit: 1, unit: 1 } }).toArray();
  const byId = new Map(found.map((p) => [String(p._id), p]));
  for (const item of items) {
    const p = item.productId ? byId.get(String(item.productId)) : null;
    if (p?.purchaseUnit && p.unitsPerPurchaseUnit > 1) {
      item.unit = p.purchaseUnit;
      item.unitsPerPurchaseUnit = p.unitsPerPurchaseUnit;
      item.stockUnit = p.unit || DEFAULT_UNIT;
    }
  }
  return items;
}

/** Finds a product by barcode among the given visible products' org. */
export async function findByBarcode(orgId, barcode) {
  const b = String(barcode || "").trim();
  if (!BARCODE.test(b)) return null;
  const { products } = await getOrgCollections();
  return products.findOne({ orgId: toObjectId(orgId), barcode: b, deletedAt: null });
}
