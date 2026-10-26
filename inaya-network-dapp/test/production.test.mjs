// test/production.test.mjs
//
// Bills of materials and production orders (src/lib/production.js): the pure
// requirement / shortage maths, then the real ledger: a BOM, a planned order,
// start refused while components are short, complete consumes components
// (batch-tracked ones earliest-expiry-first) and books the finished goods into
// a batch, a failed completion reverses what it took, shortages draft purchase
// requests once, and cancelling.
//
// Run with: node --env-file=.env.local --test test/production.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { recordStockMovement, getStockLevel } from "../src/lib/inventory.js";
import { requirementsFor, shortages, saveBom, createProductionOrder, transitionProductionOrder, materialsPlan, draftShortageRequests } from "../src/lib/production.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const actorEmail = `test-mo-${RUN_ID}@example.com`;
const owner = { role: "owner", email: actorEmail };
let c;
const orgIds = [];

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  for (const col of [c.departments, c.products, c.warehouses, c.stockLevels, c.stockMovements, c.stockLots, c.boms, c.productionOrders, c.purchaseRequests, c.orgActivity, c.auditChainEntries, c.auditChainHeads]) {
    await col.deleteMany({ orgId: { $in: orgIds } });
  }
  await c.orgs.deleteMany({ _id: { $in: orgIds } });
  await (await mongoClientPromise).close();
});

async function fixture(label) {
  const now = new Date().toISOString();
  const orgId = (await c.orgs.insertOne({ name: `${label} Co`, createdAt: now })).insertedId;
  orgIds.push(orgId);
  const departmentId = (await c.departments.insertOne({ orgId, name: "Production", createdAt: now })).insertedId;
  const warehouseId = (await c.warehouses.insertOne({ orgId, departmentId, name: "Factory", createdAt: now })).insertedId;
  const product = async (name, extra = {}) => (await c.products.insertOne({ orgId, departmentId, name, sku: `${name.slice(0, 4).toUpperCase()}-${RUN_ID}-${label}`, reorderThreshold: 0, createdAt: now, deletedAt: null, ...extra })).insertedId;
  const cream = await product("Face cream 50ml", { trackLots: true });
  const base = await product("Cream base (kg)", { trackLots: true, unitPrice: 8 });
  const jar = await product("Jar 50ml");
  return { orgId, oid: orgId.toString(), departmentId, warehouseId, cream, base, jar };
}
const stockIn = (f, productId, delta, extra = {}) => recordStockMovement({ orgId: f.orgId, productId, warehouseId: f.warehouseId, delta, type: "RECEIPT", actorEmail, ...extra });

test("requirements scale with quantity; shortages net off stock", () => {
  const bom = { outputQuantity: 100, components: [{ productId: "base", quantity: 5 }, { productId: "jar", quantity: 100 }] };
  assert.deepEqual(requirementsFor(bom, 250), [{ productId: "base", quantity: 12.5 }, { productId: "jar", quantity: 250 }]);
  const s = shortages([requirementsFor(bom, 100), requirementsFor(bom, 100)], new Map([["base", 7], ["jar", 500]]));
  assert.deepEqual(s, [{ productId: "base", needed: 10, inStock: 7, short: 3 }, { productId: "jar", needed: 200, inStock: 500, short: 0 }]);
});

test("BOM -> plan -> start refused while short -> complete consumes FEFO and books a finished batch", async () => {
  const f = await fixture("flow");
  const bom = await saveBom({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, outputQuantity: 100, components: [{ productId: f.base, quantity: 5 }, { productId: f.jar, quantity: 100 }] });
  assert.ifError(bom.error);
  const mo = await createProductionOrder({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, quantity: 200, warehouseId: f.warehouseId, dueDate: "2026-11-20" });
  assert.ifError(mo.error);
  assert.deepEqual(mo.order.requirements.map((r) => r.quantity), [10, 200]);
  const t = (action, extra = {}) => transitionProductionOrder({ orgId: f.oid, orderId: mo.order._id, action, membership: owner, actorEmail, ...extra });

  const refused = await t("start");
  assert.equal(refused.status, 409, "nothing in stock yet");
  const plan = await materialsPlan({ orgId: f.oid, membership: owner });
  assert.deepEqual(plan.map((r) => [r.productName, r.short]).sort(), [["Cream base (kg)", 10], ["Jar 50ml", 200]]);

  await stockIn(f, f.base, 6, { lotNumber: "BASE-LATE", expiryDate: "2027-12-31" });
  await stockIn(f, f.base, 6, { lotNumber: "BASE-SOON", expiryDate: "2027-03-31" });
  await stockIn(f, f.jar, 250);
  assert.equal((await t("start")).order.status, "IN_PROGRESS");
  const done = await t("complete", { lotNumber: "FC-2611", expiryDate: "2028-10-31" });
  assert.ifError(done.error);
  assert.equal(done.order.status, "COMPLETED");
  assert.deepEqual(done.order.consumed[0].lots.map((l) => [l.lotNumber, l.quantity]), [["BASE-SOON", 6], ["BASE-LATE", 4]]);
  assert.equal(await getStockLevel(f.orgId, f.base, f.warehouseId), 2);
  assert.equal(await getStockLevel(f.orgId, f.jar, f.warehouseId), 50);
  assert.equal(await getStockLevel(f.orgId, f.cream, f.warehouseId), 200);
  const finished = await c.stockLots.findOne({ orgId: f.orgId, productId: f.cream, lotNumber: "FC-2611" });
  assert.equal(finished.quantity, 200);
  assert.equal(finished.expiryDate, "2028-10-31");
  assert.equal(await c.stockMovements.countDocuments({ orgId: f.orgId, relatedProductionOrderId: mo.order._id }), 3, "2 CONSUME + 1 PRODUCE tied to the order");
  assert.equal((await t("complete")).status, 409, "completes only once");
});

test("a completion that can't finish puts back what it took", async () => {
  const f = await fixture("undo");
  await saveBom({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, outputQuantity: 1, components: [{ productId: f.jar, quantity: 1 }, { productId: f.base, quantity: 1 }] });
  const mo = await createProductionOrder({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, quantity: 5, warehouseId: f.warehouseId });
  await stockIn(f, f.jar, 5);
  await stockIn(f, f.base, 5, { lotNumber: "B1" });
  await transitionProductionOrder({ orgId: f.oid, orderId: mo.order._id, action: "start", membership: owner, actorEmail });
  // Someone uses the base elsewhere after the order started.
  await recordStockMovement({ orgId: f.orgId, productId: f.base, warehouseId: f.warehouseId, delta: -3, type: "ISSUE", actorEmail });
  const r = await transitionProductionOrder({ orgId: f.oid, orderId: mo.order._id, action: "complete", membership: owner, actorEmail });
  assert.equal(r.status, 409);
  assert.equal(await getStockLevel(f.orgId, f.jar, f.warehouseId), 5, "the jars it took were put back");
  assert.equal((await c.productionOrders.findOne({ _id: mo.order._id })).status, "IN_PROGRESS");
  assert.equal(await getStockLevel(f.orgId, f.cream, f.warehouseId), 0);
});

test("shortages draft one purchase request per component, never twice", async () => {
  const f = await fixture("short");
  await saveBom({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, outputQuantity: 100, components: [{ productId: f.base, quantity: 5 }, { productId: f.jar, quantity: 100 }] });
  await createProductionOrder({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, quantity: 100, warehouseId: f.warehouseId });
  await stockIn(f, f.jar, 100);
  const first = await draftShortageRequests({ orgId: f.oid, membership: owner, actorEmail });
  assert.deepEqual(first.drafted, ["Cream base (kg)"]);
  const pr = await c.purchaseRequests.findOne({ orgId: f.orgId, reorderForProductId: f.base });
  assert.equal(pr.status, "DRAFT");
  assert.equal(pr.reorderQuantity, 5);
  assert.equal(pr.estimatedCost, 40);
  const second = await draftShortageRequests({ orgId: f.oid, membership: owner, actorEmail });
  assert.deepEqual(second.drafted, []);
  assert.deepEqual(second.skipped, ["Cream base (kg)"]);
});

test("BOM validation, cancelling, and department access", async () => {
  const f = await fixture("rules");
  assert.equal((await saveBom({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, outputQuantity: 1, components: [{ productId: f.cream, quantity: 1 }] })).status, 400, "not its own component");
  assert.equal((await createProductionOrder({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, quantity: 1, warehouseId: f.warehouseId })).status, 409, "needs a BOM first");
  await saveBom({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, outputQuantity: 1, components: [{ productId: f.jar, quantity: 1 }] });
  const mo = await createProductionOrder({ orgId: f.oid, membership: owner, actorEmail, productId: f.cream, quantity: 1, warehouseId: f.warehouseId });
  const outsider = { role: "member", email: "x@example.com", departmentIds: [] };
  assert.equal((await transitionProductionOrder({ orgId: f.oid, orderId: mo.order._id, action: "cancel", membership: outsider, actorEmail })).status, 404);
  assert.equal((await transitionProductionOrder({ orgId: f.oid, orderId: mo.order._id, action: "cancel", membership: owner, actorEmail })).order.status, "CANCELLED");
});
