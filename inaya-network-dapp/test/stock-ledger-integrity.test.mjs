// test/stock-ledger-integrity.test.mjs -- Inaya Commerce, Batch 1 (Master SOW 5.4; Lightspeed audit P0): the stock ledger
// under concurrency. Level, lots and movement are written in one transaction; a stock-out is a guarded decrement, so
// concurrent sales can never oversell; idempotency keys stop double movements; transfers are all-or-nothing; the
// reconciliation tool finds and repairs a level that drifted from its ledger.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { recordStockMovement, transferStock, reconcileStockLevels, getStockLevel } from "../src/lib/inventory.js";

const orgId = new ObjectId(); const ORG = String(orgId);
let c, product, lotted, w1, w2;
const qty = (p, w) => getStockLevel(ORG, String(p), String(w));
before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections();
  await c.orgs.insertOne({ _id: orgId, name: "stock-integrity", createdAt: new Date().toISOString() });
  const dep = new ObjectId(); const now = new Date().toISOString();
  w1 = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Main", createdAt: now })).insertedId;
  w2 = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Branch", createdAt: now })).insertedId;
  product = (await c.products.insertOne({ orgId, departmentId: dep, sku: `SKU-${Date.now()}`, name: "Widget", status: "ACTIVE", createdAt: now })).insertedId;
  lotted = (await c.products.insertOne({ orgId, departmentId: dep, sku: `LOT-${Date.now()}`, name: "Lotted", trackLots: true, status: "ACTIVE", createdAt: now })).insertedId;
});
after(async () => {
  for (const n of ["orgs", "warehouses", "products", "stock_levels", "stock_movements", "stock_lots", "org_activity"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: orgId } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("concurrent sales can never oversell: 20 simultaneous issues of 1 against 10 in stock", { timeout: 120000 }, async () => {
  assert.ok(!(await recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: 10, type: "RECEIPT", actorEmail: "t" })).error);
  const results = await Promise.all(Array.from({ length: 20 }, () => recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: -1, type: "SALE", actorEmail: "t" })));
  assert.equal(results.filter((r) => !r.error).length, 10, "exactly the stock on hand was sold");
  assert.ok(results.filter((r) => r.error).every((r) => r.status === 409));
  assert.equal(await qty(product, w1), 0);
  const sum = (await c.stockMovements.find({ orgId, productId: product, warehouseId: w1 }).toArray()).reduce((s, m) => s + m.delta, 0);
  assert.equal(sum, 0, "the ledger agrees with the level");
});

test("an idempotency key moves stock once, however often the request is retried", async () => {
  await recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: 5, type: "RECEIPT", actorEmail: "t" });
  const key = `sale-${Date.now()}`;
  const runs = await Promise.all([1, 2, 3].map(() => recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: -2, type: "SALE", actorEmail: "t", idempotencyKey: key }).catch((e) => ({ error: e.message }))));
  const ok = runs.filter((r) => !r.error);
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok.map((r) => String(r.movement._id))).size, 1, "every retry returns the same movement");
  assert.equal(await qty(product, w1), 3, "stock moved exactly once");
  assert.equal(await c.stockMovements.countDocuments({ orgId, idempotencyKey: key }), 1);
});

test("negative stock is refused unless explicitly allowed with a reason, which is recorded", async () => {
  const refused = await recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: -10, type: "SALE", actorEmail: "t" });
  assert.equal(refused.status, 409);
  assert.equal((await recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: -10, type: "SALE", actorEmail: "t", allowNegative: { reason: "" } })).status, 400);
  const allowed = await recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: -10, type: "SALE", actorEmail: "mgr", allowNegative: { reason: "Goods on shelf, count pending" } });
  assert.ok(!allowed.error, allowed.error); assert.equal(allowed.newQuantity, -7);
  assert.equal(allowed.movement.override.reason, "Goods on shelf, count pending");
  await recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: 7, type: "COUNT", actorEmail: "mgr" });
});

test("a transfer is all-or-nothing", async () => {
  await recordStockMovement({ orgId: ORG, productId: String(product), warehouseId: String(w1), delta: 4, type: "RECEIPT", actorEmail: "t" });
  const before = await c.stockMovements.countDocuments({ orgId });
  const bad = await transferStock({ orgId: ORG, productId: String(product), sourceWarehouseId: String(w1), destWarehouseId: String(w2), quantity: 9, actorEmail: "t" });
  assert.equal(bad.status, 409);
  assert.equal(await c.stockMovements.countDocuments({ orgId }), before, "a failed transfer leaves no movement on either side");
  const good = await transferStock({ orgId: ORG, productId: String(product), sourceWarehouseId: String(w1), destWarehouseId: String(w2), quantity: 3, actorEmail: "t" });
  assert.ok(!good.error, good.error);
  assert.equal(await qty(product, w1), 1); assert.equal(await qty(product, w2), 3);
});

test("batch-tracked stock: concurrent FEFO issues never take a batch below zero", { timeout: 120000 }, async () => {
  await recordStockMovement({ orgId: ORG, productId: String(lotted), warehouseId: String(w1), delta: 3, type: "RECEIPT", actorEmail: "t", lotNumber: "A1", expiryDate: "2027-01-31" });
  await recordStockMovement({ orgId: ORG, productId: String(lotted), warehouseId: String(w1), delta: 3, type: "RECEIPT", actorEmail: "t", lotNumber: "B1", expiryDate: "2027-06-30" });
  const results = await Promise.all(Array.from({ length: 10 }, () => recordStockMovement({ orgId: ORG, productId: String(lotted), warehouseId: String(w1), delta: -1, type: "SALE", actorEmail: "t" })));
  assert.equal(results.filter((r) => !r.error).length, 6);
  const lots = await c.stockLots.find({ orgId, productId: lotted, warehouseId: w1 }).toArray();
  assert.ok(lots.every((l) => l.quantity === 0), JSON.stringify(lots.map((l) => [l.lotNumber, l.quantity])));
  assert.equal(await qty(lotted, w1), 0);
});

test("reconciliation finds a level that drifted from its ledger, and repairs it with an audit record", async () => {
  const clean = await reconcileStockLevels({ orgId: ORG });
  assert.deepEqual(clean.mismatches, [], JSON.stringify(clean.mismatches));
  await c.stockLevels.updateOne({ orgId, productId: product, warehouseId: w2 }, { $inc: { quantity: 5 } }); // simulate drift
  const found = await reconcileStockLevels({ orgId: ORG });
  assert.equal(found.mismatches.length, 1); assert.equal(found.mismatches[0].ledger, 3);
  const fixed = await reconcileStockLevels({ orgId: ORG, repair: true, actorEmail: "admin@example.com" });
  assert.equal(fixed.repaired, 1); assert.equal(await qty(product, w2), 3);
  assert.ok(await c.db.collection("org_activity").findOne({ orgId, action: "STOCK_LEVELS_REPAIRED" }));
});
