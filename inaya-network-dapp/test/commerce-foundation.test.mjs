// test/commerce-foundation.test.mjs -- Inaya Commerce, Batch 1 (Master SOW Phase 1): entitlement and roles, tax engine,
// price lists and customer prices, the server-side pricing engine (precedence, discounts, stacking, approvals, overrides,
// location availability), catalogue validation and moving-average cost through the real stock ledger.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as PR from "../src/lib/commerce/pricing.js";
import { validateCatalogueFields } from "../src/lib/commerce/catalogue.js";
import { recordStockMovement } from "../src/lib/inventory.js";

const orgId = new ObjectId(); const ORG = String(orgId);
const owner = { role: "owner", email: "owner@shop.example" };
const cashier = { role: "member", commerceRole: "cashier", email: "cash@shop.example" };
const supervisor = { role: "member", commerceRole: "supervisor", email: "sup@shop.example" };
const outsider = { role: "member", email: "x@shop.example" };
let c, w1, w2, pA, pB, pC, customer, std, list;
const base = { orgId: ORG, membership: owner, actorEmail: owner.email };
before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString(); const dep = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: "commerce-foundation", createdAt: now });
  for (const m of [owner, cashier, supervisor, outsider]) await c.orgMembers.insertOne({ orgId, ...m, status: "active", createdAt: now });
  w1 = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Lahore", createdAt: now })).insertedId;
  w2 = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Karachi", createdAt: now })).insertedId;
  const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, createdAt: now, ...x }).then((r) => r.insertedId);
  pA = await mk({ sku: `A-${Date.now()}`, name: "Shirt", unitPrice: 1000 });
  pB = await mk({ sku: `B-${Date.now()}`, name: "Cap", unitPrice: 500 });
  pC = await mk({ sku: `C-${Date.now()}`, name: "Lahore-only", unitPrice: 200, availableWarehouseIds: [String(w1)] });
  customer = (await c.crmContacts.insertOne({ orgId, departmentId: dep, name: "Wholesale Buyer", createdAt: now })).insertedId;
});
after(async () => {
  for (const n of ["orgs", "org_members", "warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "org_activity"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: orgId } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("entitlement: commerce is refused until FEATURE_COMMERCE is on; roles are enforced", async () => {
  const off = await S.commerceAccess({ orgId: ORG, membership: owner });
  assert.equal(off.code, "COMMERCE_NOT_ENABLED");
  await c.orgs.updateOne({ _id: orgId }, { $set: { "features.FEATURE_COMMERCE": true } });
  assert.equal(await S.commerceAccess({ orgId: ORG, membership: cashier }), null, "a cashier may sell");
  assert.equal((await S.commerceAccess({ orgId: ORG, membership: cashier, need: "manage" })).code, "COMMERCE_ROLE");
  assert.equal((await S.commerceAccess({ orgId: ORG, membership: outsider })).code, "COMMERCE_ROLE", "no commerce role, no access");
  assert.equal((await S.updateSettings({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { taxMode: "inclusive" } })).status, 403);
  const r = await S.setCommerceRole({ ...base, email: outsider.email, commerceRole: "cashier" });
  assert.equal(r.commerceRole, "cashier");
  assert.equal((await S.setCommerceRole({ ...base, email: owner.email, commerceRole: "cashier" })).status, 409, "owners are always managers");
});

test("settings: validated, audited; tax categories with a location override", async () => {
  assert.equal((await S.updateSettings({ ...base, input: { discountLimits: { cashierPercent: 50, supervisorPercent: 10 } } })).status, 400);
  const s = await S.updateSettings({ ...base, input: { currency: "PKR", taxMode: "exclusive", discountLimits: { cashierPercent: 10, supervisorPercent: 30 }, allowPriceOverride: "supervisor" } });
  assert.equal(s.settings.currency, "PKR");
  std = (await TAX.saveTaxCategory({ ...base, code: "STD", name: "Standard (GST)", rate: 18, isDefault: true })).category;
  assert.equal((await TAX.saveTaxCategory({ ...base, code: "STD", name: "dup", rate: 1 })).status, 409);
  await TAX.saveTaxCategory({ ...base, code: "EXEMPT", name: "Exempt", rate: 0 });
  await TAX.setLocationRate({ ...base, categoryId: std.id, warehouseId: String(w2), rate: 16 });
  const resolve = await TAX.loadTaxResolver(ORG);
  assert.equal(resolve(null, String(w1)).rate, 18, "default category at Lahore");
  assert.equal(resolve(null, String(w2)).rate, 16, "location override at Karachi");
  assert.deepEqual(TAX.taxOn(10000, 18, "exclusive"), { netMinor: 10000, taxMinor: 1800, grossMinor: 11800 });
  assert.deepEqual(TAX.taxOn(11800, 18, "inclusive"), { netMinor: 10000, taxMinor: 1800, grossMinor: 11800 });
});

test("price precedence: customer price > price list > product price; all recalculated server-side", async () => {
  list = (await PR.savePriceList({ ...base, code: "WHOLESALE", name: "Wholesale", isWholesale: true })).priceList;
  await PR.setPrice({ ...base, priceListId: list.id, productId: String(pA), price: 800 });
  await PR.setPrice({ ...base, customerId: String(customer), productId: String(pA), price: 750 });
  const plain = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), lines: [{ productId: String(pA), quantity: 2 }] } });
  assert.equal(plain.lines[0].unitPrice, 1000); assert.equal(plain.totals.total, 2360, "2 x 1000 + 18% GST");
  const listed = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), priceListId: list.id, lines: [{ productId: String(pA), quantity: 1 }] } });
  assert.equal(listed.lines[0].unitPrice, 800); assert.equal(listed.lines[0].priceSource, "price_list");
  const cust = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), customerId: String(customer), priceListId: list.id, lines: [{ productId: String(pA), quantity: 1 }] } });
  assert.equal(cust.lines[0].unitPrice, 750); assert.equal(cust.lines[0].priceSource, "customer");
  const karachi = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w2), lines: [{ productId: String(pA), quantity: 1 }] } });
  assert.equal(karachi.totals.tax, 160, "16% at the Karachi location");
});

test("discounts: line + order, spread for tax; role limits produce approvals; best_only stacking", async () => {
  const r = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), lines: [{ productId: String(pA), quantity: 1, discount: { type: "percent", value: 10 } }, { productId: String(pB), quantity: 2 }], orderDiscount: { type: "amount", value: 100 } } });
  assert.equal(r.totals.subtotal, 2000); assert.equal(r.totals.discounts, 200, "100 line + 100 order");
  assert.equal(r.lines[0].orderDiscountShare + r.lines[1].orderDiscountShare, 100, "the order discount is fully spread");
  assert.equal(r.totals.net, 1800); assert.equal(r.totals.tax, 324); assert.equal(r.totals.total, 2124);
  assert.deepEqual(r.approvals, [], "10% is within the cashier limit");
  const big = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), lines: [{ productId: String(pA), quantity: 1, discount: { type: "percent", value: 25 } }] } });
  assert.equal(big.approvals[0].needed, "supervisor");
  const sup = await PR.priceCart({ orgId: ORG, membership: supervisor, input: { warehouseId: String(w1), lines: [{ productId: String(pA), quantity: 1, discount: { type: "percent", value: 25 } }] } });
  assert.deepEqual(sup.approvals, [], "a supervisor covers 25%");
  const huge = await PR.priceCart({ orgId: ORG, membership: supervisor, input: { warehouseId: String(w1), lines: [{ productId: String(pA), quantity: 1, discount: { type: "percent", value: 50 } }] } });
  assert.equal(huge.approvals[0].needed, "manager");
  await S.updateSettings({ ...base, input: { stacking: "best_only" } });
  const best = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), lines: [{ productId: String(pA), quantity: 1, discount: { type: "percent", value: 5 } }], orderDiscount: { type: "percent", value: 8 } } });
  assert.equal(best.totals.discounts, 80, "only the larger (8%) applies");
  await S.updateSettings({ ...base, input: { stacking: "line_and_order" } });
});

test("price overrides need the configured role; inactive, unpriced and location-restricted products are refused", async () => {
  const ov = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), lines: [{ productId: String(pB), quantity: 1, priceOverride: 400 }] } });
  assert.equal(ov.approvals[0].kind, "price_override"); assert.equal(ov.approvals[0].needed, "supervisor"); assert.equal(ov.lines[0].unitPrice, 400);
  await S.updateSettings({ ...base, input: { allowPriceOverride: "never" } });
  assert.equal((await PR.priceCart({ orgId: ORG, membership: owner, input: { warehouseId: String(w1), lines: [{ productId: String(pB), quantity: 1, priceOverride: 400 }] } })).code, "OVERRIDE_DISABLED");
  await S.updateSettings({ ...base, input: { allowPriceOverride: "supervisor" } });
  assert.equal((await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w2), lines: [{ productId: String(pC), quantity: 1 }] } })).status, 409, "not sold at Karachi");
  await c.products.updateOne({ _id: pB }, { $set: { status: "INACTIVE" } });
  assert.equal((await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w1), lines: [{ productId: String(pB), quantity: 1 }] } })).status, 409);
  await c.products.updateOne({ _id: pB }, { $set: { status: "ACTIVE" } });
  assert.equal((await PR.priceCart({ orgId: ORG, membership: cashier, input: { lines: [{ productId: String(pA), quantity: -1 }] } })).status, 400);
  assert.equal(PR.cashRounded(2124 * 100 + 37, 100), 212400, "cash rounding to the nearest 1.00");
});

test("catalogue validation and moving-average cost through the stock ledger", async () => {
  assert.ok(validateCatalogueFields({ productType: "BUNDLE" }).error);
  assert.ok(validateCatalogueFields({ productType: "SERVICE", trackLots: true }).error);
  const ok = validateCatalogueFields({ productType: "STOCK", category: "Apparel", tags: ["Summer", "summer", "Cotton"], variantGroupId: "shirt-1", variantAttributes: { Size: "M", Colour: "Blue" }, costPrice: 400 });
  assert.deepEqual(ok.fields.tags, ["summer", "cotton"]); assert.deepEqual(ok.fields.variantAttributes, { size: "M", colour: "Blue" });
  await recordStockMovement({ orgId: ORG, productId: String(pA), warehouseId: String(w1), delta: 10, type: "RECEIPT", actorEmail: "t", unitCost: 500 });
  await recordStockMovement({ orgId: ORG, productId: String(pA), warehouseId: String(w2), delta: 10, type: "RECEIPT", actorEmail: "t", unitCost: 600 });
  let p = await c.products.findOne({ _id: pA });
  assert.equal(p.avgCost, 550, "(10 x 500 + 10 x 600) / 20"); assert.equal(p.lastPurchaseCost, 600);
  const sale = await recordStockMovement({ orgId: ORG, productId: String(pA), warehouseId: String(w1), delta: -4, type: "SALE", actorEmail: "t" });
  assert.equal(sale.movement.unitCost, 550, "the sale carries its cost for COGS");
  await recordStockMovement({ orgId: ORG, productId: String(pA), warehouseId: String(w1), delta: 4, type: "RECEIPT", actorEmail: "t", unitCost: 700 });
  p = await c.products.findOne({ _id: pA });
  assert.equal(p.avgCost, 580, "(16 x 550 + 4 x 700) / 20");
});
