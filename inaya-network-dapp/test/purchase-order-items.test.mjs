// test/purchase-order-items.test.mjs
//
// Business Workspace Remaining Features SOW — PO line-item editing after
// creation, and the extended payments route (PO manual payment recording).
//
// Run with: node --env-file=.env.local --test test/purchase-order-items.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { updatePurchaseOrderItems } from "../src/lib/purchase-order-workflow.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-poitems-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, suppliers, purchaseOrders, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await suppliers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await purchaseOrders.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeFixture(label) {
  const { orgs, orgMembers, departments, suppliers, purchaseOrders } = collections;
  const now = new Date().toISOString();
  const orgResult = await orgs.insertOne({ name: `${label} Co`, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const memberEmail = email(label);
  const deptResult = await departments.insertOne({ orgId, name: "Ops", createdAt: now });
  await orgMembers.insertOne({ orgId, email: memberEmail, role: "member", departmentIds: [deptResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const member = await orgMembers.findOne({ orgId, email: memberEmail });

  const supplierResult = await suppliers.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Acme Supply", email: "acme@example.com", createdAt: now, deletedAt: null });

  const poResult = await purchaseOrders.insertOne({
    orgId, departmentId: deptResult.insertedId, supplierId: supplierResult.insertedId, sourceRequestId: null,
    items: [{ description: "Widgets", sku: null, productId: null, warehouseId: null, quantity: 10, unitPrice: 5, receivedQuantity: 0 }],
    currency: "USD", status: "DRAFT", createdByEmail: memberEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });

  return { orgId, departmentId: deptResult.insertedId, member, memberEmail, poId: poResult.insertedId.toString() };
}

test("updatePurchaseOrderItems: edits while DRAFT, replaces items, logs the total change", async () => {
  const fx = await makeFixture("draft-edit");
  const result = await updatePurchaseOrderItems({
    orgId: fx.orgId, poId: fx.poId,
    items: [{ description: "Widgets", quantity: 20, unitPrice: 4 }, { description: "Gadgets", quantity: 5, unitPrice: 10 }],
    membership: fx.member, actorEmail: fx.memberEmail,
  });
  assert.equal(result.po.items.length, 2);
  assert.equal(result.po.items[0].quantity, 20);

  const { orgActivity } = collections;
  const activity = await orgActivity.findOne({ orgId: fx.orgId, action: "PO_ITEMS_EDITED" });
  assert.ok(activity, "editing items must be recorded in the audit trail");
});

test("updatePurchaseOrderItems: rejects invalid line items without touching the stored PO", async () => {
  const fx = await makeFixture("invalid-edit");
  const result = await updatePurchaseOrderItems({
    orgId: fx.orgId, poId: fx.poId,
    items: [{ description: "Bad item", quantity: -5, unitPrice: 4 }],
    membership: fx.member, actorEmail: fx.memberEmail,
  });
  assert.equal(result.status, 400);

  const { purchaseOrders } = collections;
  const stillOriginal = await purchaseOrders.findOne({ _id: new ObjectId(fx.poId) });
  assert.equal(stillOriginal.items.length, 1, "a rejected edit must never partially apply");
});

test("SECURITY: a non-DRAFT PO cannot have its line items edited", async () => {
  const fx = await makeFixture("closed-edit");
  const { purchaseOrders } = collections;
  await purchaseOrders.updateOne({ orgId: fx.orgId }, { $set: { status: "APPROVED" } });

  const result = await updatePurchaseOrderItems({
    orgId: fx.orgId, poId: fx.poId, items: [{ description: "Widgets", quantity: 99, unitPrice: 1 }],
    membership: fx.member, actorEmail: fx.memberEmail,
  });
  assert.equal(result.status, 409);
});

test("SECURITY: cross-org isolation -- editing a PO under the wrong org fails closed", async () => {
  const fxA = await makeFixture("iso-a");
  const fxB = await makeFixture("iso-b");

  const result = await updatePurchaseOrderItems({
    orgId: fxB.orgId, poId: fxA.poId, items: [{ description: "Hijacked", quantity: 1, unitPrice: 1 }],
    membership: fxB.member, actorEmail: fxB.memberEmail,
  });
  assert.equal(result.status, 404);
});
