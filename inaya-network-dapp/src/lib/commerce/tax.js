// src/lib/commerce/tax.js -- Inaya Commerce, Batch 1 (Master SOW 6.4): a configurable tax foundation. No country's rules
// are hard-coded (approved decision: PK sales tax and UK VAT are entered as configurable rates; filing/compliance is
// separate work). A tax CATEGORY (Standard, Reduced, Zero-rated, Exempt...) has a default rate; a location (warehouse)
// can override the rate of a category. A product names its category (catalogue.js taxCategoryId) or uses the company's
// default category. Rates are percentages with up to 3 decimals; maths is in integer minor units.
import { ccol, ensureCommerceIndexes, KINDS, fail, clean, nowIso, oid, sid, commerceAccess, audit } from "./store.js";

const rateOk = (r) => Number.isFinite(r) && r >= 0 && r <= 100 && Math.round(r * 1000) === r * 1000;
const view = (d) => ({ id: sid(d._id), code: d.code, name: d.name, rate: d.rate, isDefault: !!d.isDefault, active: d.active !== false, updatedAt: d.updatedAt });

export async function listTaxCategories(orgId) {
  await ensureCommerceIndexes(); const c = await ccol();
  const cats = await c.find({ orgId: oid(orgId), kind: KINDS.taxCategory }).sort({ name: 1 }).toArray();
  const rates = await c.find({ orgId: oid(orgId), kind: KINDS.taxRate }).toArray();
  return cats.map((x) => ({ ...view(x), locationRates: rates.filter((r) => sid(r.categoryId) === sid(x._id)).map((r) => ({ warehouseId: sid(r.warehouseId), rate: r.rate })) }));
}

export async function saveTaxCategory({ orgId, membership, actorEmail, id = null, code, name, rate, isDefault = false, active = true }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const cd = clean(code, 20).toUpperCase(); const nm = clean(name, 80);
  if (!/^[A-Z0-9_-]{1,20}$/.test(cd)) return fail("Code: 1-20 letters, digits, - or _.");
  if (!nm) return fail("Name is required."); if (!rateOk(Number(rate))) return fail("Rate must be a percentage between 0 and 100 (up to 3 decimals).");
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso(); const o = oid(orgId);
  if (isDefault) await c.updateMany({ orgId: o, kind: KINDS.taxCategory, isDefault: true }, { $set: { isDefault: false } });
  try {
    if (id) {
      const before = await c.findOne({ _id: oid(id), orgId: o, kind: KINDS.taxCategory }); if (!before) return fail("Tax category not found.", 404);
      await c.updateOne({ _id: before._id }, { $set: { code: cd, name: nm, rate: Number(rate), isDefault: !!isDefault, active: active !== false, updatedAt: now, updatedBy: actorEmail } });
      await audit({ orgId, actorEmail, recordType: "TAX_CATEGORY", recordId: before._id, action: "TAX_CHANGED", previousState: view(before), newState: { code: cd, name: nm, rate: Number(rate), isDefault: !!isDefault } });
      return { category: view(await c.findOne({ _id: before._id })) };
    }
    const r = await c.insertOne({ orgId: o, kind: KINDS.taxCategory, code: cd, name: nm, rate: Number(rate), isDefault: !!isDefault, active: true, createdAt: now, createdBy: actorEmail, updatedAt: now });
    await audit({ orgId, actorEmail, recordType: "TAX_CATEGORY", recordId: r.insertedId, action: "TAX_CREATED", newState: { code: cd, name: nm, rate: Number(rate) } });
    return { category: view(await c.findOne({ _id: r.insertedId })) };
  } catch (e) { if (e?.code === 11000) return fail(`A tax category with code ${cd} already exists.`, 409); throw e; }
}

/** Location-specific rate for a category (null rate removes the override). */
export async function setLocationRate({ orgId, membership, actorEmail, categoryId, warehouseId, rate }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  await ensureCommerceIndexes(); const c = await ccol(); const o = oid(orgId);
  const cat = await c.findOne({ _id: oid(categoryId), orgId: o, kind: KINDS.taxCategory }); if (!cat) return fail("Tax category not found.", 404);
  const { warehouses } = await (await import("../orgs.js")).getOrgCollections();
  if (!(await warehouses.findOne({ _id: oid(warehouseId), orgId: o }))) return fail("Location (warehouse) not found.", 404);
  const key = { orgId: o, kind: KINDS.taxRate, categoryId: cat._id, warehouseId: oid(warehouseId) };
  if (rate === null) { await c.deleteOne(key); }
  else { if (!rateOk(Number(rate))) return fail("Rate must be a percentage between 0 and 100."); await c.updateOne(key, { $set: { rate: Number(rate), updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: key }, { upsert: true }); }
  await audit({ orgId, actorEmail, recordType: "TAX_CATEGORY", recordId: cat._id, action: "TAX_LOCATION_RATE", newState: { warehouseId: sid(warehouseId), rate } });
  return { categories: await listTaxCategories(orgId) };
}

/** Resolver used by the pricing engine: one load per cart, then pure lookups. */
export async function loadTaxResolver(orgId, session = null) {
  const c = await ccol(); const o = oid(orgId);
  const cats = await c.find({ orgId: o, kind: KINDS.taxCategory, active: { $ne: false } }, { session }).toArray();
  const rates = await c.find({ orgId: o, kind: KINDS.taxRate }, { session }).toArray();
  const byId = new Map(cats.map((x) => [sid(x._id), x])); const def = cats.find((x) => x.isDefault) || null;
  const override = new Map(rates.map((r) => [`${sid(r.categoryId)}:${sid(r.warehouseId)}`, r.rate]));
  return (taxCategoryId, warehouseId) => {
    const cat = (taxCategoryId && byId.get(String(taxCategoryId))) || def;
    if (!cat) return { categoryId: null, code: null, name: "No tax", rate: 0 };
    const loc = override.get(`${sid(cat._id)}:${sid(warehouseId)}`);
    return { categoryId: sid(cat._id), code: cat.code, name: cat.name, rate: loc !== undefined ? loc : cat.rate };
  };
}

/** Pure: tax for an amount already net of discounts. mode "exclusive": amount is net, tax added on top; "inclusive":
 *  amount already contains tax. Half-up rounding to whole minor units. */
export function taxOn(amountMinor, ratePercent, mode) {
  if (!ratePercent) return { netMinor: amountMinor, taxMinor: 0, grossMinor: amountMinor };
  if (mode === "inclusive") { const tax = Math.round((amountMinor * ratePercent) / (100 + ratePercent)); return { netMinor: amountMinor - tax, taxMinor: tax, grossMinor: amountMinor }; }
  const tax = Math.round((amountMinor * ratePercent) / 100); return { netMinor: amountMinor, taxMinor: tax, grossMinor: amountMinor + tax };
}
