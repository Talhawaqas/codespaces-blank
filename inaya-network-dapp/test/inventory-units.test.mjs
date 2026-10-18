// test/inventory-units.test.mjs
//
// Business Workspace gap closure, Batch 3 — barcodes and units of measure
// (src/lib/inventory-units.js), including the purchase-order receipt
// conversion. Products and PO lines without the new fields behave as before.
//
// Run with: node --env-file=.env.local --test test/inventory-units.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { validateUnitFields, stockUnitsFor, applyPurchaseUnits, findByBarcode } from "../src/lib/inventory-units.js";
import { receivePurchaseOrder, updatePurchaseOrderItems } from "../src/lib/purchase-order-workflow.js";
import { totalStockForProduct } from "../src/lib/inventory.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const ACTOR = `test-units-${RUN_ID}@example.com`;
const OWNER = { role: "owner" };
let c;
const cleanup = { orgIds: [] };

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  const f = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([c.products, c.warehouses, c.stockLevels, c.stockMovements, c.purchaseOrders, c.departments, c.orgActivity, c.auditChainEntries, c.auditChainHeads].map((x) => x.deleteMany(f)));
  await c.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await (await mongoClientPromise).close();
});

async function fixture() {
  const now = new Date().toISOString();
  const orgId = (await c.orgs.insertOne({ name: `units-${RUN_ID}`, createdAt: now })).insertedId;
  cleanup.orgIds.push(orgId);
  const dept = (await c.departments.insertOne({ orgId, name: "Ops", createdAt: now })).insertedId;
  const wh = (await c.warehouses.insertOne({ orgId, departmentId: dept, name: "Main", createdAt: now })).insertedId;
  const product = (extra) => c.products.insertOne({ orgId, departmentId: dept, sku: `SKU-${randomUUID().slice(0, 6)}`, name: "Widget", status: "ACTIVE", deletedAt: null, createdAt: now, ...extra }).then((r) => r.insertedId);
  return { orgId, id: orgId.toString(), dept, wh, product, now };
}

test("validateUnitFields: barcode, unit and purchase-unit conversion rules", () => {
  assert.deepEqual(validateUnitFields({}).fields, {});
  assert.deepEqual(validateUnitFields({ barcode: " 4006381333931 ", unit: "KG" }).fields, { barcode: "4006381333931", unit: "kg" });
  assert.deepEqual(validateUnitFields({ purchaseUnit: "Box", unitsPerPurchaseUnit: 12 }).fields, { purchaseUnit: "box", unitsPerPurchaseUnit: 12 });
  assert.match(validateUnitFields({ purchaseUnit: "box", unitsPerPurchaseUnit: 1 }).error, /2 to 100000/);
  assert.match(validateUnitFields({ barcode: "<script>" }).error, /Barcode/);
  assert.deepEqual(validateUnitFields({ purchaseUnit: null }).fields, { purchaseUnit: null, unitsPerPurchaseUnit: null }, "clearing removes both");
  assert.equal(stockUnitsFor({ unitsPerPurchaseUnit: 12 }, 3), 36);
  assert.equal(stockUnitsFor({}, 3), 3);
});

test("barcodes are unique per org and found by lookup", async () => {
  const fx = await fixture();
  const code = `BC-${RUN_ID}`;
  await fx.product({ barcode: code });
  await assert.rejects(() => fx.product({ barcode: code }), /E11000/, "the partial unique index blocks a duplicate barcode");
  await fx.product({}); await fx.product({}); // products without a barcode never collide
  assert.equal((await findByBarcode(fx.id, code)).barcode, code);
  assert.equal(await findByBarcode(fx.id, "nope-1234"), null);
});

test("PO receipt: boxes convert to stock units from the snapshot; plain lines are unchanged", async () => {
  const fx = await fixture();
  const boxed = await fx.product({ unit: "each", purchaseUnit: "box", unitsPerPurchaseUnit: 12 });
  const plain = await fx.product({});
  const items = await applyPurchaseUnits(fx.id, [
    { description: "Widgets", productId: boxed, warehouseId: fx.wh, quantity: 5, unitPrice: 60, receivedQuantity: 0 },
    { description: "Bolts", productId: plain, warehouseId: fx.wh, quantity: 4, unitPrice: 1, receivedQuantity: 0 },
  ]);
  assert.equal(items[0].unitsPerPurchaseUnit, 12);
  assert.equal(items[1].unitsPerPurchaseUnit, undefined);
  const po = (await c.purchaseOrders.insertOne({ orgId: fx.orgId, departmentId: fx.dept, supplierId: fx.dept, items, currency: "USD", status: "ORDERED", deletedAt: null, createdAt: fx.now })).insertedId;

  // The product's conversion changing later never rewrites an existing PO line.
  await c.products.updateOne({ _id: boxed }, { $set: { unitsPerPurchaseUnit: 24 } });
  const r = await receivePurchaseOrder({ orgId: fx.id, poId: po.toString(), receipts: [{ itemIndex: 0, quantity: 3 }, { itemIndex: 1, quantity: 4 }], membership: OWNER, actorEmail: ACTOR });
  assert.equal(r.error, undefined);
  assert.equal(await totalStockForProduct(fx.id, boxed), 36, "3 boxes x 12");
  assert.equal(await totalStockForProduct(fx.id, plain), 4);
  assert.equal(r.po.status, "PARTIALLY_RECEIVED", "PO quantities stay in purchase units (3 of 5 boxes)");
});

test("editing DRAFT PO lines snapshots the current purchase unit", async () => {
  const fx = await fixture();
  const boxed = await fx.product({ purchaseUnit: "case", unitsPerPurchaseUnit: 6 });
  const po = (await c.purchaseOrders.insertOne({ orgId: fx.orgId, departmentId: fx.dept, supplierId: fx.dept, items: [{ description: "x", quantity: 1, receivedQuantity: 0 }], currency: "USD", status: "DRAFT", deletedAt: null, createdAt: fx.now })).insertedId;
  const r = await updatePurchaseOrderItems({ orgId: fx.id, poId: po.toString(), items: [{ description: "Cases", productId: boxed.toString(), warehouseId: fx.wh.toString(), quantity: 2 }], membership: OWNER, actorEmail: ACTOR });
  assert.equal(r.error, undefined);
  const stored = await c.purchaseOrders.findOne({ _id: po });
  assert.deepEqual({ unit: stored.items[0].unit, per: stored.items[0].unitsPerPurchaseUnit }, { unit: "case", per: 6 });
});
