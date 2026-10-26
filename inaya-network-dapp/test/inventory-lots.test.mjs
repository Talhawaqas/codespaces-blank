// test/inventory-lots.test.mjs
//
// Batch / lot tracking (src/lib/inventory-lots.js through
// recordStockMovement / transferStock): FEFO allocation on its own, then the
// real ledger: stock-in needs a batch, stock-out takes the earliest expiry
// first, a named batch can't go negative, transfers carry the batches (with
// expiry) to the other warehouse, and turning tracking on turns existing
// stock into an OPENING-STOCK batch.
//
// Run with: node --env-file=.env.local --test test/inventory-lots.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { recordStockMovement, transferStock, getStockLevel } from "../src/lib/inventory.js";
import { allocateFefo, fefoSort, normalizeExpiryDate, daysUntilExpiry, openingLotsForExistingStock, OPENING_LOT } from "../src/lib/inventory-lots.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const actorEmail = `test-lots-${RUN_ID}@example.com`;
let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, departments, products, warehouses, stockLevels, stockMovements, stockLots, orgActivity, auditChainEntries, auditChainHeads } = collections;
  for (const col of [departments, products, warehouses, stockLevels, stockMovements, stockLots, orgActivity, auditChainEntries, auditChainHeads]) {
    await col.deleteMany({ orgId: { $in: cleanup.orgIds } });
  }
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await (await mongoClientPromise).close();
});

async function fixture(label, { trackLots = true } = {}) {
  const { orgs, departments, products, warehouses } = collections;
  const now = new Date().toISOString();
  const orgId = (await orgs.insertOne({ name: `${label} Co`, createdAt: now })).insertedId;
  cleanup.orgIds.push(orgId);
  const departmentId = (await departments.insertOne({ orgId, name: "Ops", createdAt: now })).insertedId;
  const productId = (await products.insertOne({ orgId, departmentId, name: "Syrup 120ml", sku: `LOT-${RUN_ID}-${label}`, reorderThreshold: 0, trackLots, createdAt: now, deletedAt: null })).insertedId;
  const a = (await warehouses.insertOne({ orgId, departmentId, name: "Main", createdAt: now })).insertedId;
  const b = (await warehouses.insertOne({ orgId, departmentId, name: "Depot", createdAt: now })).insertedId;
  return { orgId, productId, a, b };
}
const lotsAt = async (f, warehouseId) => Object.fromEntries((await collections.stockLots.find({ orgId: f.orgId, productId: f.productId, warehouseId }).toArray()).map((l) => [l.lotNumber, l.quantity]));

test("FEFO: earliest expiry first, undated last, oldest first on a tie", () => {
  const lots = [
    { lotNumber: "NODATE", expiryDate: null, quantity: 10, createdAt: "2026-01-01" },
    { lotNumber: "LATE", expiryDate: "2027-06-01", quantity: 5, createdAt: "2026-01-02" },
    { lotNumber: "SOON", expiryDate: "2026-12-01", quantity: 4, createdAt: "2026-01-03" },
  ];
  assert.deepEqual(fefoSort(lots).map((l) => l.lotNumber), ["SOON", "LATE", "NODATE"]);
  assert.deepEqual(allocateFefo(lots, 7).lots.map((l) => [l.lotNumber, l.quantity]), [["SOON", 4], ["LATE", 3]]);
  assert.equal(allocateFefo(lots, 30).error, "not enough");
  assert.equal(allocateFefo(lots, 30).available, 19);
});

test("expiry dates are validated and counted in days", () => {
  assert.equal(normalizeExpiryDate(""), null);
  assert.equal(normalizeExpiryDate("2026-12-31"), "2026-12-31");
  assert.ok(normalizeExpiryDate("31/12/2026").error);
  assert.equal(daysUntilExpiry("2026-11-05", "2026-11-01"), 4);
  assert.equal(daysUntilExpiry("2026-10-30", "2026-11-01"), -2);
});

test("stock-in to a batch-tracked product needs a batch number", async () => {
  const f = await fixture("needlot");
  const r = await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 10, type: "RECEIPT", actorEmail });
  assert.equal(r.status, 400);
  assert.equal(await getStockLevel(f.orgId, f.productId, f.a), 0);
});

test("stock-out takes the earliest-expiring batch first and records which batches", async () => {
  const f = await fixture("fefo");
  await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 10, type: "RECEIPT", actorEmail, lotNumber: "B-LATE", expiryDate: "2027-09-30" });
  await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 6, type: "RECEIPT", actorEmail, lotNumber: "B-SOON", expiryDate: "2027-01-31" });
  const out = await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: -8, type: "ISSUE", actorEmail });
  assert.ifError(out.error);
  assert.deepEqual(out.lots.map((l) => [l.lotNumber, l.quantity]), [["B-SOON", 6], ["B-LATE", 2]]);
  assert.deepEqual(await lotsAt(f, f.a), { "B-SOON": 0, "B-LATE": 8 });
  assert.equal(await getStockLevel(f.orgId, f.productId, f.a), 8);
  const traced = await collections.stockMovements.countDocuments({ orgId: f.orgId, "lots.lotNumber": "B-SOON" });
  assert.equal(traced, 2, "the batch's receipt and issue are both traceable");
});

test("a named batch can't be taken below zero, and nothing changes when refused", async () => {
  const f = await fixture("named");
  await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 5, type: "RECEIPT", actorEmail, lotNumber: "B1" });
  await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 5, type: "RECEIPT", actorEmail, lotNumber: "B2" });
  const r = await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: -7, type: "ISSUE", actorEmail, lotNumber: "B1" });
  assert.equal(r.status, 409);
  assert.deepEqual(await lotsAt(f, f.a), { B1: 5, B2: 5 });
  assert.equal(await getStockLevel(f.orgId, f.productId, f.a), 10);
});

test("a transfer moves the same batches, with their expiry, to the other warehouse", async () => {
  const f = await fixture("transfer");
  await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 4, type: "RECEIPT", actorEmail, lotNumber: "T-SOON", expiryDate: "2027-02-01" });
  await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 4, type: "RECEIPT", actorEmail, lotNumber: "T-LATE", expiryDate: "2027-08-01" });
  const r = await transferStock({ orgId: f.orgId, productId: f.productId, sourceWarehouseId: f.a.toString(), destWarehouseId: f.b.toString(), quantity: 6, actorEmail });
  assert.ifError(r.error);
  assert.deepEqual(await lotsAt(f, f.a), { "T-SOON": 0, "T-LATE": 2 });
  assert.deepEqual(await lotsAt(f, f.b), { "T-SOON": 4, "T-LATE": 2 });
  const arrived = await collections.stockLots.findOne({ orgId: f.orgId, warehouseId: f.b, lotNumber: "T-SOON" });
  assert.equal(arrived.expiryDate, "2027-02-01");
});

test("turning tracking on makes existing stock an OPENING-STOCK batch", async () => {
  const f = await fixture("opening", { trackLots: false });
  await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: 12, type: "RECEIPT", actorEmail });
  assert.deepEqual(await lotsAt(f, f.a), {}, "untracked products don't create batches");
  await collections.products.updateOne({ _id: f.productId }, { $set: { trackLots: true } });
  await openingLotsForExistingStock({ stockLevels: collections.stockLevels, stockLots: collections.stockLots, orgId: f.orgId, productId: f.productId });
  assert.deepEqual(await lotsAt(f, f.a), { [OPENING_LOT]: 12 });
  const out = await recordStockMovement({ orgId: f.orgId, productId: f.productId, warehouseId: f.a, delta: -5, type: "ISSUE", actorEmail });
  assert.ifError(out.error);
  assert.deepEqual(await lotsAt(f, f.a), { [OPENING_LOT]: 7 });
});
