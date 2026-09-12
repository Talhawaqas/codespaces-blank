// test/inventory-transfer.test.mjs
//
// Business Workspace Remaining Features SOW — Warehouse-to-Warehouse
// Transfer. transferStock() is a thin orchestration over the existing,
// already-battle-tested recordStockMovement() -- these tests prove the
// orchestration itself (reject same-warehouse, reject insufficient stock,
// correct net effect on both warehouses), not recordStockMovement's own
// math again.
//
// Run with: node --env-file=.env.local --test test/inventory-transfer.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transferStock, getStockLevel, recordStockMovement } from "../src/lib/inventory.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-transfer-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, departments, products, warehouses, stockLevels, stockMovements, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await products.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await warehouses.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await stockLevels.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await stockMovements.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeFixture(label, initialStock = 50) {
  const { orgs, departments, products, warehouses } = collections;
  const now = new Date().toISOString();
  const orgResult = await orgs.insertOne({ name: `${label} Co`, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  const deptResult = await departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const productResult = await products.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Widget", sku: `SKU-${RUN_ID}-${label}`, reorderThreshold: 0, createdAt: now, deletedAt: null });
  const warehouseA = await warehouses.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Warehouse A", createdAt: now });
  const warehouseB = await warehouses.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Warehouse B", createdAt: now });

  await recordStockMovement({ orgId, productId: productResult.insertedId, warehouseId: warehouseA.insertedId, delta: initialStock, type: "RECEIPT", actorEmail: email(label) });

  return { orgId, productId: productResult.insertedId.toString(), warehouseAId: warehouseA.insertedId.toString(), warehouseBId: warehouseB.insertedId.toString(), actorEmail: email(label) };
}

test("transferStock: moves the exact quantity from source to destination", async () => {
  const fx = await makeFixture("basic");
  const result = await transferStock({ orgId: fx.orgId, productId: fx.productId, sourceWarehouseId: fx.warehouseAId, destWarehouseId: fx.warehouseBId, quantity: 15, actorEmail: fx.actorEmail });
  assert.ok(result.transferId);
  assert.equal(result.from.newQuantity, 35);
  assert.equal(result.to.newQuantity, 15);

  const [sourceLevel, destLevel] = await Promise.all([
    getStockLevel(fx.orgId, fx.productId, fx.warehouseAId),
    getStockLevel(fx.orgId, fx.productId, fx.warehouseBId),
  ]);
  assert.equal(sourceLevel, 35);
  assert.equal(destLevel, 15);
});

test("VALIDATION: rejects identical source and destination warehouses", async () => {
  const fx = await makeFixture("same-wh");
  const result = await transferStock({ orgId: fx.orgId, productId: fx.productId, sourceWarehouseId: fx.warehouseAId, destWarehouseId: fx.warehouseAId, quantity: 5, actorEmail: fx.actorEmail });
  assert.equal(result.status, 400);
});

test("VALIDATION: rejects a transfer exceeding available stock, without moving anything", async () => {
  const fx = await makeFixture("insufficient", 10);
  const result = await transferStock({ orgId: fx.orgId, productId: fx.productId, sourceWarehouseId: fx.warehouseAId, destWarehouseId: fx.warehouseBId, quantity: 999, actorEmail: fx.actorEmail });
  assert.equal(result.status, 409);

  const destLevel = await getStockLevel(fx.orgId, fx.productId, fx.warehouseBId);
  assert.equal(destLevel, 0, "a rejected transfer must never partially apply to the destination");
});

test("SECURITY: cross-org isolation -- a transfer cannot move stock belonging to another org", async () => {
  const fxA = await makeFixture("iso-a");
  const fxB = await makeFixture("iso-b");

  // fxB's orgId with fxA's warehouse/product ids -- must not find real
  // stock to move, since recordStockMovement's own org-scoped filter
  // means fxA's product/warehouse simply doesn't exist under fxB's org.
  const result = await transferStock({ orgId: fxB.orgId, productId: fxA.productId, sourceWarehouseId: fxA.warehouseAId, destWarehouseId: fxA.warehouseBId, quantity: 5, actorEmail: fxB.actorEmail });
  assert.equal(result.status, 409, "no stock exists for this product under org B, so the transfer must fail closed");
});
