// test/inventory-reorder.test.mjs
//
// Business Workspace gap closure, Batch 1 — low stock -> DRAFT purchase
// request (src/lib/inventory-reorder.js). The automatic run is scoped to
// this test's own orgs so it can never draft requests in real data.
//
// Run with: node --env-file=.env.local --test test/inventory-reorder.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import { draftReorderRequest, findOpenReorderRequest, runAutoReorder, suggestedReorderQuantity } from "../src/lib/inventory-reorder.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-reorder-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, departments, products, warehouses, stockLevels, stockMovements, purchaseRequests, purchaseOrders, orgActivity, auditChainEntries, auditChainHeads, db } = collections;
  const filter = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([departments, products, warehouses, stockLevels, stockMovements, purchaseRequests, purchaseOrders, orgActivity, auditChainEntries, auditChainHeads]
    .map((c) => c.deleteMany(filter)));
  await Promise.all(["notifications", "notification_deliveries"].map((n) => db.collection(n).deleteMany(filter)));
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeFixture(label, { stock = 3, threshold = 5, unitPrice = 12.5, autoReorder = false, reorderQuantity } = {}) {
  const now = new Date().toISOString();
  const org = await collections.orgs.insertOne({ name: `${label} Co`, createdAt: now });
  cleanup.orgIds.push(org.insertedId);
  const orgId = org.insertedId;
  const dept = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const product = await collections.products.insertOne({
    orgId, departmentId: dept.insertedId, sku: `SKU-${RUN_ID}-${label}`, name: "Widget", unitPrice,
    reorderThreshold: threshold, status: "ACTIVE", createdAt: now, deletedAt: null,
    ...(autoReorder ? { autoReorder: true } : {}), ...(reorderQuantity ? { reorderQuantity } : {}),
  });
  const warehouse = await collections.warehouses.insertOne({ orgId, departmentId: dept.insertedId, name: "Main", createdAt: now });
  if (stock > 0) await recordStockMovement({ orgId, productId: product.insertedId, warehouseId: warehouse.insertedId, delta: stock, type: "RECEIPT", actorEmail: email(label) });
  return { orgId, orgIdStr: orgId.toString(), departmentId: dept.insertedId, productId: product.insertedId.toString(), actor: email(label) };
}

test("suggestedReorderQuantity: explicit quantity, else enough to reach twice the threshold", () => {
  assert.equal(suggestedReorderQuantity({ reorderQuantity: 40, reorderThreshold: 5 }, 2), 40);
  assert.equal(suggestedReorderQuantity({ reorderThreshold: 5 }, 2), 8);
  assert.equal(suggestedReorderQuantity({ reorderThreshold: 1 }, 5), 1, "never below 1");
});

test("draftReorderRequest: low stock creates a DRAFT request linked to the product, priced from unitPrice", async () => {
  const fx = await makeFixture("draft");
  const result = await draftReorderRequest({ orgId: fx.orgIdStr, productId: fx.productId, actorEmail: fx.actor });
  assert.equal(result.created, true);
  const pr = await collections.purchaseRequests.findOne({ _id: result.request._id });
  assert.equal(pr.status, "DRAFT", "never submitted on anyone's behalf");
  assert.equal(pr.reorderForProductId.toString(), fx.productId);
  assert.equal(pr.reorderQuantity, 7, "2 x 5 - 3");
  assert.equal(pr.estimatedCost, 87.5);
  assert.equal(pr.departmentId.toString(), fx.departmentId.toString());
  assert.ok(await collections.orgActivity.findOne({ recordId: pr._id, action: "REORDER_DRAFTED" }), "audited");
});

test("draftReorderRequest: no second draft while one is in flight; allowed again once stock was received", async () => {
  const fx = await makeFixture("dedupe");
  const first = await draftReorderRequest({ orgId: fx.orgIdStr, productId: fx.productId, actorEmail: fx.actor });
  const again = await draftReorderRequest({ orgId: fx.orgIdStr, productId: fx.productId, actorEmail: fx.actor });
  assert.equal(again.created, false);
  assert.equal(again.request._id.toString(), first.request._id.toString());

  // Approved but its PO not yet received: still in flight.
  await collections.purchaseRequests.updateOne({ _id: first.request._id }, { $set: { status: "APPROVED" } });
  const po = await collections.purchaseOrders.insertOne({ orgId: fx.orgId, departmentId: fx.departmentId, sourceRequestId: first.request._id, status: "ORDERED", items: [], deletedAt: null });
  assert.ok(await findOpenReorderRequest(fx.orgIdStr, fx.productId));

  // PO fully received: the reorder is settled, a new low-stock reading may draft again.
  await collections.purchaseOrders.updateOne({ _id: po.insertedId }, { $set: { status: "RECEIVED" } });
  assert.equal(await findOpenReorderRequest(fx.orgIdStr, fx.productId), null);
  const next = await draftReorderRequest({ orgId: fx.orgIdStr, productId: fx.productId, actorEmail: fx.actor });
  assert.equal(next.created, true);
});

test("draftReorderRequest: refused when stock is above the threshold or the product is discontinued", async () => {
  const fx = await makeFixture("healthy", { stock: 50 });
  const healthy = await draftReorderRequest({ orgId: fx.orgIdStr, productId: fx.productId, actorEmail: fx.actor });
  assert.equal(healthy.status, 409);

  const fx2 = await makeFixture("discontinued");
  await collections.products.updateOne({ sku: `SKU-${RUN_ID}-discontinued` }, { $set: { status: "DISCONTINUED" } });
  assert.equal((await draftReorderRequest({ orgId: fx2.orgIdStr, productId: fx2.productId, actorEmail: fx2.actor })).status, 409);
});

test("runAutoReorder: drafts only for opted-in low-stock products, and is idempotent", async () => {
  const optedIn = await makeFixture("auto-on", { autoReorder: true, reorderQuantity: 20 });
  const optedOut = await makeFixture("auto-off", { autoReorder: false });
  const scope = [optedIn.orgIdStr, optedOut.orgIdStr];

  const first = await runAutoReorder({ orgIds: scope });
  assert.equal(first.drafted, 1);
  assert.equal(first.failed, 0);
  const pr = await collections.purchaseRequests.findOne({ orgId: optedIn.orgId });
  assert.equal(pr.reorderSource, "auto");
  assert.equal(pr.reorderQuantity, 20);
  assert.equal(await collections.purchaseRequests.countDocuments({ orgId: optedOut.orgId }), 0, "opt-out product untouched");

  const second = await runAutoReorder({ orgIds: scope });
  assert.equal(second.drafted, 0);
  assert.equal(await collections.purchaseRequests.countDocuments({ orgId: optedIn.orgId }), 1);
});
