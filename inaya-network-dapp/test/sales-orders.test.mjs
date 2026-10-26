// test/sales-orders.test.mjs
//
// Sales (wholesale) orders, src/lib/sales-orders.js: create -> confirm
// (stock checked) -> dispatch (stock leaves through the ledger, batches
// earliest-expiry-first and tied to the order) -> invoice (a DRAFT invoice
// from the lines); invoicing before dispatch; cancelling; permissions.
//
// Run with: node --env-file=.env.local --test test/sales-orders.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { recordStockMovement, getStockLevel } from "../src/lib/inventory.js";
import { createSalesOrder, transitionSalesOrder } from "../src/lib/sales-orders.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const actorEmail = `test-so-${RUN_ID}@example.com`;
const owner = { role: "owner", email: actorEmail };
let c;
const orgIds = [];

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  for (const col of [c.departments, c.products, c.warehouses, c.stockLevels, c.stockMovements, c.stockLots, c.salesOrders, c.invoices, c.crmContacts, c.orgActivity, c.auditChainEntries, c.auditChainHeads]) {
    await col.deleteMany({ orgId: { $in: orgIds } });
  }
  await c.orgs.deleteMany({ _id: { $in: orgIds } });
  await (await mongoClientPromise).close();
});

async function fixture(label) {
  const now = new Date().toISOString();
  const orgId = (await c.orgs.insertOne({ name: `${label} Co`, createdAt: now })).insertedId;
  orgIds.push(orgId);
  const departmentId = (await c.departments.insertOne({ orgId, name: "Sales", createdAt: now })).insertedId;
  const warehouseId = (await c.warehouses.insertOne({ orgId, departmentId, name: "Main", createdAt: now })).insertedId;
  const ale = (await c.products.insertOne({ orgId, departmentId, name: "Pale Ale 500ml", sku: `ALE-${RUN_ID}-${label}`, unitPrice: 2.5, trackLots: true, reorderThreshold: 0, createdAt: now, deletedAt: null })).insertedId;
  const glass = (await c.products.insertOne({ orgId, departmentId, name: "Branded glass", sku: `GLS-${RUN_ID}-${label}`, unitPrice: 4, reorderThreshold: 0, createdAt: now, deletedAt: null })).insertedId;
  const contactId = (await c.crmContacts.insertOne({ orgId, departmentId, type: "CUSTOMER", name: "Sam", company: "The Fox Inn", paymentTerms: "Net 14", createdAt: now, deletedAt: null })).insertedId;
  await recordStockMovement({ orgId, productId: ale, warehouseId, delta: 30, type: "RECEIPT", actorEmail, lotNumber: "ALE-LATE", expiryDate: "2027-09-01" });
  await recordStockMovement({ orgId, productId: ale, warehouseId, delta: 20, type: "RECEIPT", actorEmail, lotNumber: "ALE-SOON", expiryDate: "2027-03-01" });
  await recordStockMovement({ orgId, productId: glass, warehouseId, delta: 10, type: "RECEIPT", actorEmail });
  const order = (lines) => createSalesOrder({ orgId: orgId.toString(), membership: owner, actorEmail, departmentId: departmentId.toString(), contactId: contactId.toString(), warehouseId: warehouseId.toString(), currency: "GBP", lines });
  return { orgId, departmentId, warehouseId, ale, glass, contactId, order };
}

test("order -> confirm -> dispatch (FEFO batches tied to the order) -> invoice", async () => {
  const f = await fixture("flow");
  const created = await f.order([{ productId: f.ale.toString(), quantity: 24, unitPrice: 2.5 }, { productId: f.glass.toString(), quantity: 6, unitPrice: 4 }]);
  assert.ifError(created.error);
  assert.equal(created.order.status, "DRAFT");
  assert.equal(created.order.subtotal, 84);
  const id = created.order.id;
  const t = (action, membership = owner) => transitionSalesOrder({ orgId: f.orgId.toString(), orderId: id, action, membership, actorEmail });

  assert.equal((await t("confirm")).order.status, "CONFIRMED");
  const dispatched = await t("fulfil");
  assert.ifError(dispatched.error);
  assert.equal(dispatched.order.status, "FULFILLED");
  assert.deepEqual(dispatched.order.lines[0].dispatchedLots.map((l) => [l.lotNumber, l.quantity]), [["ALE-SOON", 20], ["ALE-LATE", 4]]);
  assert.equal(await getStockLevel(f.orgId, f.ale, f.warehouseId), 26);
  assert.equal(await getStockLevel(f.orgId, f.glass, f.warehouseId), 4);
  const so = await c.salesOrders.findOne({ orgId: f.orgId });
  assert.equal(await c.stockMovements.countDocuments({ orgId: f.orgId, relatedSalesOrderId: so._id }), 2, "both lines' stock movements point at the order");
  const tied = await c.stockMovements.countDocuments({ orgId: f.orgId, "lots.lotNumber": "ALE-SOON", type: "ISSUE" });
  assert.equal(tied, 1, "the dispatch is traceable through the batch");

  const invoiced = await t("invoice");
  assert.ifError(invoiced.error);
  assert.equal(invoiced.order.status, "INVOICED");
  const inv = await c.invoices.findOne({ _id: (await c.salesOrders.findOne({ orgId: f.orgId })).invoiceId });
  assert.equal(inv.status, "DRAFT");
  assert.equal(inv.currency, "GBP");
  assert.equal(inv.lineItems.length, 2);
  assert.equal(inv.reference, created.order.orderNumber);
  const dueInDays = Math.round((Date.parse(inv.dueDate) - Date.now()) / 86400000);
  assert.ok(dueInDays >= 13 && dueInDays <= 14, "due date follows the customer's Net 14 terms");
  assert.equal((await t("invoice")).status, 409, "an order is invoiced only once");
});

test("confirm refuses when the warehouse doesn't have the stock, and nothing moves", async () => {
  const f = await fixture("short");
  const created = await f.order([{ productId: f.glass.toString(), quantity: 11, unitPrice: 4 }]);
  const r = await transitionSalesOrder({ orgId: f.orgId.toString(), orderId: created.order.id, action: "confirm", membership: owner, actorEmail });
  assert.equal(r.status, 409);
  assert.match(r.error, /have 10, need 11/);
  assert.equal(await getStockLevel(f.orgId, f.glass, f.warehouseId), 10);
});

test("invoicing before dispatch keeps the order dispatchable; it ends INVOICED", async () => {
  const f = await fixture("early");
  const created = await f.order([{ productId: f.glass.toString(), quantity: 2, unitPrice: 4 }]);
  const t = (action) => transitionSalesOrder({ orgId: f.orgId.toString(), orderId: created.order.id, action, membership: owner, actorEmail });
  await t("confirm");
  const inv = await t("invoice");
  assert.equal(inv.order.status, "CONFIRMED");
  assert.ok(inv.order.invoiceId);
  assert.equal((await t("cancel")).status, 409, "an invoiced order can't be cancelled here");
  assert.equal((await t("fulfil")).order.status, "INVOICED");
});

test("a draft can be cancelled; a dispatched order can't", async () => {
  const f = await fixture("cancel");
  const a = await f.order([{ productId: f.glass.toString(), quantity: 1, unitPrice: 4 }]);
  assert.equal((await transitionSalesOrder({ orgId: f.orgId.toString(), orderId: a.order.id, action: "cancel", membership: owner, actorEmail })).order.status, "CANCELLED");
  const b = await f.order([{ productId: f.glass.toString(), quantity: 1, unitPrice: 4 }]);
  for (const action of ["confirm", "fulfil"]) await transitionSalesOrder({ orgId: f.orgId.toString(), orderId: b.order.id, action, membership: owner, actorEmail });
  assert.equal((await transitionSalesOrder({ orgId: f.orgId.toString(), orderId: b.order.id, action: "cancel", membership: owner, actorEmail })).status, 409);
});

test("permissions: other departments can't see orders; invoicing needs finance access", async () => {
  const f = await fixture("perm");
  const created = await f.order([{ productId: f.glass.toString(), quantity: 1, unitPrice: 4 }]);
  const outsider = { role: "member", email: "x@example.com", departmentIds: [] };
  assert.equal((await transitionSalesOrder({ orgId: f.orgId.toString(), orderId: created.order.id, action: "confirm", membership: outsider, actorEmail })).status, 404);
  const salesStaff = { role: "member", email: "s@example.com", departmentIds: [f.departmentId] };
  assert.equal((await transitionSalesOrder({ orgId: f.orgId.toString(), orderId: created.order.id, action: "confirm", membership: salesStaff, actorEmail })).order.status, "CONFIRMED");
  assert.equal((await transitionSalesOrder({ orgId: f.orgId.toString(), orderId: created.order.id, action: "invoice", membership: salesStaff, actorEmail })).status, 403);
  assert.equal((await createSalesOrder({ orgId: f.orgId.toString(), membership: outsider, actorEmail, departmentId: f.departmentId.toString(), contactId: f.contactId.toString(), warehouseId: f.warehouseId.toString(), lines: [{ productId: f.glass.toString(), quantity: 1, unitPrice: 1 }] })).status, 403);
});
