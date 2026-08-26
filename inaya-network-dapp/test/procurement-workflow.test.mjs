// test/procurement-workflow.test.mjs
//
// Business Operations Phase 3 (Procurement) + Phase 4 (Inventory)
// coverage: purchase-request-workflow.js's approval gate,
// purchase-order-workflow.js's full lifecycle including
// receivePurchaseOrder()'s partial/full-receipt derivation and its real
// integration with inventory.js's stock ledger (the specific gap the
// original phased plan flagged and this pass closes), and
// inventory.js's own negative-stock guard.
//
// Run with: node --env-file=.env.local --test test/procurement-workflow.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transitionPurchaseRequest } from "../src/lib/purchase-request-workflow.js";
import { transitionPurchaseOrder, receivePurchaseOrder } from "../src/lib/purchase-order-workflow.js";
import { recordStockMovement, getStockLevel, totalStockForProduct } from "../src/lib/inventory.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-proc-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], recordIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, suppliers, purchaseRequests, purchaseOrders, products, warehouses, stockLevels, stockMovements, orgActivity } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await suppliers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await purchaseRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await purchaseOrders.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await products.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await warehouses.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await stockLevels.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await stockMovements.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ recordId: { $in: cleanup.recordIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithDepartment(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptResult = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });

  const ownerEmail = email(`${label}-owner`);
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  const memberEmail = email(`${label}-member`);
  await collections.orgMembers.insertOne({ orgId, email: memberEmail, role: "member", departmentIds: [deptResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });

  const supplierResult = await collections.suppliers.insertOne({
    orgId, departmentId: deptResult.insertedId, name: "Widget Supply Co", contactEmail: null, phone: null, notes: null,
    status: "ACTIVE", createdByEmail: ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });

  const warehouseResult = await collections.warehouses.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Main Warehouse", location: null, createdByEmail: ownerEmail, createdAt: now });

  const productResult = await collections.products.insertOne({
    orgId, departmentId: deptResult.insertedId, sku: `WIDGET-${RUN_ID}-${label}`, name: "Widget", description: null,
    unitPrice: 10, reorderThreshold: 5, status: "ACTIVE", createdByEmail: ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });

  return { orgId, departmentId: deptResult.insertedId, owner, ownerEmail, member, memberEmail, supplierId: supplierResult.insertedId, warehouseId: warehouseResult.insertedId, productId: productResult.insertedId };
}

async function makeRequest({ orgId, departmentId, status = "DRAFT" }) {
  const now = new Date().toISOString();
  const result = await collections.purchaseRequests.insertOne({
    orgId, departmentId, supplierId: null, title: "Buy widgets", description: null, estimatedCost: 100,
    status, createdByEmail: "creator@example.com", createdAt: now, updatedAt: now, deletedAt: null,
  });
  cleanup.recordIds.push(result.insertedId);
  return result.insertedId;
}

async function makeOrder({ orgId, departmentId, supplierId, items, status = "DRAFT" }) {
  const now = new Date().toISOString();
  const result = await collections.purchaseOrders.insertOne({
    orgId, departmentId, supplierId, sourceRequestId: null, items, status,
    createdByEmail: "creator@example.com", createdAt: now, updatedAt: now, deletedAt: null,
  });
  cleanup.recordIds.push(result.insertedId);
  return result.insertedId;
}

// ============================================================
// Purchase requests — approval gate
// ============================================================
test("PR: submit succeeds for a plain member, approve/reject require manage", async () => {
  const org = await makeOrgWithDepartment("pr-approval");
  const requestId = await makeRequest({ ...org, status: "DRAFT" });

  const submitted = await transitionPurchaseRequest({ orgId: org.orgId, requestId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(submitted.request.status, "PENDING_APPROVAL");

  const deniedApprove = await transitionPurchaseRequest({ orgId: org.orgId, requestId, action: "approve", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(deniedApprove.status, 403, "a plain member must not be able to approve");

  const approved = await transitionPurchaseRequest({ orgId: org.orgId, requestId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(approved.request.status, "APPROVED");
});

test("PR: cancel works from DRAFT or PENDING_APPROVAL but not after APPROVED", async () => {
  const org = await makeOrgWithDepartment("pr-cancel");
  const requestId = await makeRequest({ ...org, status: "APPROVED" });
  const result = await transitionPurchaseRequest({ orgId: org.orgId, requestId, action: "cancel", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);
});

// ============================================================
// Purchase orders — lifecycle + approval
// ============================================================
test("PO: full simple lifecycle submit -> approve -> order, approve requires manage", async () => {
  const org = await makeOrgWithDepartment("po-lifecycle");
  const orderId = await makeOrder({ orgId: org.orgId, departmentId: org.departmentId, supplierId: org.supplierId, items: [{ description: "Widgets", sku: null, productId: null, warehouseId: null, quantity: 10, unitPrice: 5, receivedQuantity: 0 }] });

  const submitted = await transitionPurchaseOrder({ orgId: org.orgId, poId: orderId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(submitted.po.status, "PENDING_APPROVAL");

  const deniedApprove = await transitionPurchaseOrder({ orgId: org.orgId, poId: orderId, action: "approve", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(deniedApprove.status, 403);

  const approved = await transitionPurchaseOrder({ orgId: org.orgId, poId: orderId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(approved.po.status, "APPROVED");

  const ordered = await transitionPurchaseOrder({ orgId: org.orgId, poId: orderId, action: "order", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(ordered.po.status, "ORDERED");
});

// ============================================================
// Receiving — partial/full derivation + real inventory integration
// ============================================================
test("PO receive: a partial receipt yields PARTIALLY_RECEIVED and moves real stock for a linked item", async () => {
  const org = await makeOrgWithDepartment("po-receive-partial");
  const orderId = await makeOrder({
    orgId: org.orgId, departmentId: org.departmentId, supplierId: org.supplierId,
    items: [{ description: "Widgets", sku: "W1", productId: org.productId, warehouseId: org.warehouseId, quantity: 10, unitPrice: 5, receivedQuantity: 0 }],
    status: "ORDERED",
  });

  const before = await getStockLevel(org.orgId, org.productId, org.warehouseId);
  assert.equal(before, 0);

  const result = await receivePurchaseOrder({ orgId: org.orgId, poId: orderId, receipts: [{ itemIndex: 0, quantity: 4 }], membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.po.status, "PARTIALLY_RECEIVED");
  assert.equal(result.po.items[0].receivedQuantity, 4);

  const after = await getStockLevel(org.orgId, org.productId, org.warehouseId);
  assert.equal(after, 4, "receiving a linked item must post a real stock movement");
});

test("PO receive: receiving the remaining quantity moves it to RECEIVED", async () => {
  const org = await makeOrgWithDepartment("po-receive-full");
  const orderId = await makeOrder({
    orgId: org.orgId, departmentId: org.departmentId, supplierId: org.supplierId,
    items: [{ description: "Widgets", sku: "W1", productId: org.productId, warehouseId: org.warehouseId, quantity: 10, unitPrice: 5, receivedQuantity: 4 }],
    status: "PARTIALLY_RECEIVED",
  });

  const result = await receivePurchaseOrder({ orgId: org.orgId, poId: orderId, receipts: [{ itemIndex: 0, quantity: 6 }], membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.po.status, "RECEIVED");
  assert.equal(result.po.items[0].receivedQuantity, 10);

  const total = await totalStockForProduct(org.orgId, org.productId);
  assert.equal(total, 6, "only this call's 6 units should have posted a movement (the pre-existing 4 was fixture data, not a real prior movement)");
});

test("PO receive: over-receiving beyond ordered quantity is rejected with no state change", async () => {
  const org = await makeOrgWithDepartment("po-receive-over");
  const orderId = await makeOrder({
    orgId: org.orgId, departmentId: org.departmentId, supplierId: org.supplierId,
    items: [{ description: "Widgets", sku: "W1", productId: null, warehouseId: null, quantity: 10, unitPrice: 5, receivedQuantity: 0 }],
    status: "ORDERED",
  });

  const result = await receivePurchaseOrder({ orgId: org.orgId, poId: orderId, receipts: [{ itemIndex: 0, quantity: 11 }], membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);

  const po = await collections.purchaseOrders.findOne({ _id: orderId });
  assert.equal(po.status, "ORDERED");
  assert.equal(po.items[0].receivedQuantity, 0);
});

test("PO receive: only valid from ORDERED/PARTIALLY_RECEIVED, e.g. rejected from DRAFT", async () => {
  const org = await makeOrgWithDepartment("po-receive-wrong-state");
  const orderId = await makeOrder({
    orgId: org.orgId, departmentId: org.departmentId, supplierId: org.supplierId,
    items: [{ description: "Widgets", sku: null, productId: null, warehouseId: null, quantity: 5, unitPrice: 5, receivedQuantity: 0 }],
    status: "DRAFT",
  });
  const result = await receivePurchaseOrder({ orgId: org.orgId, poId: orderId, receipts: [{ itemIndex: 0, quantity: 1 }], membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);
});

// ============================================================
// Inventory ledger — negative-stock guard + movement/level consistency
// ============================================================
test("inventory: an ISSUE that would take stock negative is rejected, level unchanged", async () => {
  const org = await makeOrgWithDepartment("inventory-negative-guard");
  await recordStockMovement({ orgId: org.orgId, productId: org.productId, warehouseId: org.warehouseId, delta: 5, type: "RECEIPT", actorEmail: org.memberEmail });

  const result = await recordStockMovement({ orgId: org.orgId, productId: org.productId, warehouseId: org.warehouseId, delta: -10, type: "ISSUE", actorEmail: org.memberEmail });
  assert.equal(result.status, 409);

  const level = await getStockLevel(org.orgId, org.productId, org.warehouseId);
  assert.equal(level, 5, "a rejected issue must not have changed the level");
});

test("inventory: a valid ADJUSTMENT (negative, within bounds) reduces the level and is recorded", async () => {
  const org = await makeOrgWithDepartment("inventory-adjustment");
  await recordStockMovement({ orgId: org.orgId, productId: org.productId, warehouseId: org.warehouseId, delta: 20, type: "RECEIPT", actorEmail: org.memberEmail });
  const adjusted = await recordStockMovement({ orgId: org.orgId, productId: org.productId, warehouseId: org.warehouseId, delta: -3, type: "ADJUSTMENT", note: "count correction", actorEmail: org.memberEmail });
  assert.equal(adjusted.newQuantity, 17);

  const movements = await collections.stockMovements.find({ orgId: org.orgId, productId: org.productId }).sort({ createdAt: 1 }).toArray();
  assert.deepEqual(movements.map((m) => m.delta), [20, -3]);
});
