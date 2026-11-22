// src/lib/commerce/catalogue.js -- Inaya Commerce, Batch 1 (Master SOW 6.2 / 7.2): the catalogue fields commerce needs,
// added to the ONE product catalogue (`products`), never a second POS catalogue.
//   productType      STOCK (default; moves stock) | NON_STOCK (sold, not counted) | SERVICE (time/labour)
//   category, brand, tags
//   variantGroupId / variantGroupName / variantAttributes   each variant is its own product (own SKU, barcode, stock,
//                    price); products sharing a variantGroupId are shown as one item with a variant picker
//   imageDocumentIds Inaya Documents holding the product images (encrypted storage), max 8
//   wholesalePrice   second price point (price lists add more)
//   costPrice        standard/manual cost; avgCost and lastPurchaseCost are maintained by the stock ledger (inventory.js)
//   taxCategoryId    a commerce tax category (tax.js); none = the company's default category
//   availableWarehouseIds  locations where it may be sold; empty = everywhere
//   posVisible       shown on the register (default true)
// validateCatalogueFields returns only the keys that were sent, so PATCH never clears fields by omission.
import { clean } from "./store.js";
import { toObjectId } from "../orgs.js";

export const PRODUCT_TYPES = ["STOCK", "NON_STOCK", "SERVICE", "KIT", "GIFT_CARD"]; // GIFT_CARD: sold at the till, issues a gift card (a liability), no tax, no stock // KIT: sold as one item, its components leave stock
const money = (v) => v === null || (Number.isFinite(v) && v >= 0);
const idOk = (v) => { try { toObjectId(String(v)); return true; } catch { return false; } };

export function validateCatalogueFields(body = {}) {
  const f = {};
  if (body.productType !== undefined) { if (!PRODUCT_TYPES.includes(body.productType)) return { error: "productType must be STOCK, NON_STOCK, SERVICE, KIT or GIFT_CARD." }; f.productType = body.productType; }
  if (body.category !== undefined) f.category = clean(body.category, 80) || null;
  if (body.brand !== undefined) f.brand = clean(body.brand, 80) || null;
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 20) return { error: "tags must be a list of up to 20 labels." };
    f.tags = [...new Set(body.tags.map((t) => clean(t, 40).toLowerCase()).filter(Boolean))];
  }
  if (body.variantGroupId !== undefined) f.variantGroupId = body.variantGroupId ? clean(body.variantGroupId, 60) : null;
  if (body.variantGroupName !== undefined) f.variantGroupName = clean(body.variantGroupName, 120) || null;
  if (body.variantAttributes !== undefined) {
    const a = body.variantAttributes;
    if (a !== null && (typeof a !== "object" || Array.isArray(a) || Object.keys(a).length > 5)) return { error: "variantAttributes must be up to 5 name/value pairs, e.g. { size: \"M\" }." };
    f.variantAttributes = a ? Object.fromEntries(Object.entries(a).map(([k, v]) => [clean(k, 30).toLowerCase(), clean(v, 60)]).filter(([k, v]) => k && v)) : null;
  }
  if (body.imageDocumentIds !== undefined) {
    if (!Array.isArray(body.imageDocumentIds) || body.imageDocumentIds.length > 8 || !body.imageDocumentIds.every(idOk)) return { error: "imageDocumentIds must be up to 8 document ids." };
    f.imageDocumentIds = body.imageDocumentIds.map(String);
  }
  for (const k of ["wholesalePrice", "costPrice"]) if (body[k] !== undefined) { if (!money(body[k])) return { error: `${k} must be a non-negative number or null.` }; f[k] = body[k] === null ? null : Math.round(body[k] * 10000) / 10000; }
  if (body.taxCategoryId !== undefined) { if (body.taxCategoryId !== null && !idOk(body.taxCategoryId)) return { error: "taxCategoryId is not valid." }; f.taxCategoryId = body.taxCategoryId ? String(body.taxCategoryId) : null; }
  if (body.availableWarehouseIds !== undefined) {
    if (!Array.isArray(body.availableWarehouseIds) || body.availableWarehouseIds.length > 200 || !body.availableWarehouseIds.every(idOk)) return { error: "availableWarehouseIds must be a list of warehouse ids." };
    f.availableWarehouseIds = [...new Set(body.availableWarehouseIds.map(String))];
  }
  if (body.posVisible !== undefined) { if (typeof body.posVisible !== "boolean") return { error: "posVisible must be true or false." }; f.posVisible = body.posVisible; }
  // Stock control (Master SOW 7.2, 7.4, 7.12): min/max, safety stock, lead time, preferred supplier, per-location rules
  for (const k of ["minStock", "maxStock", "safetyStock", "leadTimeDays"]) if (body[k] !== undefined) { if (body[k] !== null && !(Number.isFinite(body[k]) && body[k] >= 0 && body[k] <= 1e9)) return { error: `${k} must be a non-negative number or null.` }; f[k] = body[k]; }
  if (f.minStock != null && f.maxStock != null && f.maxStock < f.minStock) return { error: "maxStock can't be below minStock." };
  if (body.preferredSupplierId !== undefined) { if (body.preferredSupplierId !== null && !idOk(body.preferredSupplierId)) return { error: "preferredSupplierId is not valid." }; f.preferredSupplierId = body.preferredSupplierId ? String(body.preferredSupplierId) : null; }
  if (body.locationRules !== undefined) {
    if (!Array.isArray(body.locationRules) || body.locationRules.length > 200) return { error: "locationRules must be a list." };
    const rules = [];
    for (const r of body.locationRules) {
      if (!idOk(r?.warehouseId)) return { error: "Each location rule needs a warehouseId." };
      const rule = { warehouseId: String(r.warehouseId) };
      for (const k of ["reorderThreshold", "minStock", "maxStock", "safetyStock"]) if (r[k] !== undefined && r[k] !== null) { if (!(Number.isFinite(r[k]) && r[k] >= 0)) return { error: `locationRules.${k} must be a non-negative number.` }; rule[k] = r[k]; }
      if (r.bin !== undefined) rule.bin = clean(r.bin, 40) || null; // bin / rack / shelf location
      rules.push(rule);
    }
    f.locationRules = rules;
  }
  if (body.kitComponents !== undefined) {
    if (body.kitComponents !== null && (!Array.isArray(body.kitComponents) || body.kitComponents.length > 50 || !body.kitComponents.every((c) => idOk(c?.productId) && Number.isFinite(c?.quantity) && c.quantity > 0))) return { error: "kitComponents must be up to 50 { productId, quantity } entries." };
    f.kitComponents = body.kitComponents ? body.kitComponents.map((c) => ({ productId: String(c.productId), quantity: c.quantity })) : null;
  }
  if (f.productType === "KIT" && !(f.kitComponents?.length) && body.kitComponents !== undefined) return { error: "A KIT product needs kitComponents." };
  if (f.kitComponents?.length && f.productType && f.productType !== "KIT") return { error: "Only a KIT product has kitComponents." };
  if (body.trackSerials !== undefined) { if (typeof body.trackSerials !== "boolean") return { error: "trackSerials must be true or false." }; f.trackSerials = body.trackSerials; if (body.trackSerials) f.trackLots = true; }
  if (f.productType && f.productType !== "STOCK" && (body.trackLots === true || body.trackSerials === true)) return { error: "Only stock products can track batches or serial numbers." };
  return { fields: f };
}

/** Catalogue part of a product's API view. */
export function catalogueView(p) {
  return {
    productType: p.productType || "STOCK", category: p.category || null, brand: p.brand || null, tags: p.tags || [],
    variantGroupId: p.variantGroupId || null, variantGroupName: p.variantGroupName || null, variantAttributes: p.variantAttributes || null,
    imageDocumentIds: p.imageDocumentIds || [], wholesalePrice: p.wholesalePrice ?? null, costPrice: p.costPrice ?? null,
    avgCost: p.avgCost ?? null, lastPurchaseCost: p.lastPurchaseCost ?? null, taxCategoryId: p.taxCategoryId || null,
    availableWarehouseIds: p.availableWarehouseIds || [], posVisible: p.posVisible !== false,
    minStock: p.minStock ?? null, maxStock: p.maxStock ?? null, safetyStock: p.safetyStock ?? null, leadTimeDays: p.leadTimeDays ?? null,
    preferredSupplierId: p.preferredSupplierId || null, locationRules: p.locationRules || [], kitComponents: p.kitComponents || null, trackSerials: !!p.trackSerials,
  };
}

/** Fields whose change is a price/tax event (audited and emitted as price.changed). */
export const PRICE_FIELDS = ["unitPrice", "wholesalePrice", "costPrice", "taxCategoryId"];
export const isStocked = (p) => (p?.productType || "STOCK") === "STOCK";
export const isKit = (p) => p?.productType === "KIT";
/** The stock movements behind selling or returning `quantity` of a line: the product itself, or a kit's components. */
export async function stockLegs({ orgId, productId, productType, quantity, session = null }) {
  if (isStocked({ productType })) return [{ productId: String(productId), quantity }];
  if (!isKit({ productType })) return [];
  const { getOrgCollections, toObjectId } = await import("../orgs.js");
  const { products } = await getOrgCollections();
  const kit = await products.findOne({ _id: toObjectId(productId), orgId: toObjectId(orgId) }, { projection: { kitComponents: 1 }, session });
  return (kit?.kitComponents || []).map((c) => ({ productId: String(c.productId), quantity: Math.round(c.quantity * quantity * 1e6) / 1e6 }));
}
export const availableAt = (p, warehouseId) => !p?.availableWarehouseIds?.length || p.availableWarehouseIds.includes(String(warehouseId));
