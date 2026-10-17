// test/supplier-scorecard.test.mjs
//
// Business Workspace gap closure, Batch 1 — supplier scorecards
// (src/lib/supplier-scorecard.js) and PO tax/shipping totals
// (src/lib/purchase-order-totals.js). PO activity events are inserted with
// controlled timestamps so lead time and on-time delivery are exact.
//
// Run with: node --env-file=.env.local --test test/supplier-scorecard.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { computeSupplierScorecard } from "../src/lib/supplier-scorecard.js";
import { computePoTotals, validatePoExtras } from "../src/lib/purchase-order-totals.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER = { role: "owner", departmentIds: [] };

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, departments, suppliers, purchaseOrders, orgActivity } = collections;
  const filter = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([departments, suppliers, purchaseOrders, orgActivity].map((c) => c.deleteMany(filter)));
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

test("computePoTotals: a PO without tax/shipping totals exactly the line-item sum", () => {
  const items = [{ quantity: 3, unitPrice: 10 }, { quantity: 2, unitPrice: 2.25 }, { quantity: 1, unitPrice: null }];
  assert.deepEqual(computePoTotals({ items }), { subtotal: 34.5, taxRate: 0, taxAmount: 0, shippingCost: 0, total: 34.5 });
  assert.deepEqual(computePoTotals({ items, taxRate: 10, shippingCost: 5 }), { subtotal: 34.5, taxRate: 10, taxAmount: 3.45, shippingCost: 5, total: 42.95 });
});

test("validatePoExtras: only provided keys, with range checks", () => {
  assert.deepEqual(validatePoExtras({}), { fields: {} });
  assert.deepEqual(validatePoExtras({ taxRate: "7.5", shippingCost: 0, expectedDeliveryDate: "2026-11-02T10:00:00Z" }).fields, { taxRate: 7.5, shippingCost: 0, expectedDeliveryDate: "2026-11-02" });
  assert.ok(validatePoExtras({ taxRate: 101 }).error);
  assert.ok(validatePoExtras({ shippingCost: -1 }).error);
  assert.ok(validatePoExtras({ expectedDeliveryDate: "not a date" }).error);
  assert.deepEqual(validatePoExtras({ taxRate: null }).fields, { taxRate: null }, "null clears");
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const org = await collections.orgs.insertOne({ name: `${label} Co`, createdAt: now });
  cleanup.orgIds.push(org.insertedId);
  const orgId = org.insertedId;
  const deptA = await collections.departments.insertOne({ orgId, name: "A", createdAt: now });
  const deptB = await collections.departments.insertOne({ orgId, name: "B", createdAt: now });
  const supplier = await collections.suppliers.insertOne({ orgId, departmentId: deptA.insertedId, name: `Acme ${RUN_ID}`, status: "ACTIVE", createdAt: now, deletedAt: null });
  return { orgId, orgIdStr: orgId.toString(), deptA: deptA.insertedId, deptB: deptB.insertedId, supplierId: supplier.insertedId };
}

async function makePo(fx, { status, items, expectedDeliveryDate, departmentId = fx.deptA, orderedAt, receivedAt }) {
  const r = await collections.purchaseOrders.insertOne({
    orgId: fx.orgId, departmentId, supplierId: fx.supplierId, items, status, currency: "USD",
    createdAt: "2026-09-01T00:00:00.000Z", deletedAt: null, ...(expectedDeliveryDate ? { expectedDeliveryDate } : {}),
  });
  const event = (action, timestamp) => ({ eventId: randomUUID(), orgId: fx.orgId, recordType: "PURCHASE_ORDER", recordId: r.insertedId, actorEmail: "t@example.com", action, previousState: null, newState: null, timestamp, metadata: {} });
  const events = [];
  if (orderedAt) events.push(event("PO_ORDERED", orderedAt));
  if (receivedAt) events.push(event("PO_RECEIVED", receivedAt));
  if (events.length) await collections.orgActivity.insertMany(events);
  return r.insertedId;
}

test("scorecard: fill rate, on-time rate, lead time and cancellation rate from real PO data", async () => {
  const fx = await makeOrg("score");
  // On time: expected 09-10, received 09-08, ordered 09-01 -> 7 days.
  await makePo(fx, { status: "RECEIVED", items: [{ quantity: 5, receivedQuantity: 5 }], expectedDeliveryDate: "2026-09-10", orderedAt: "2026-09-01T00:00:00.000Z", receivedAt: "2026-09-08T00:00:00.000Z" });
  // Late: expected 09-05, received 09-12, ordered 09-02 -> 10 days.
  await makePo(fx, { status: "RECEIVED", items: [{ quantity: 10, receivedQuantity: 10 }], expectedDeliveryDate: "2026-09-05", orderedAt: "2026-09-02T00:00:00.000Z", receivedAt: "2026-09-12T00:00:00.000Z" });
  // Outstanding: 0 of 5 received.
  await makePo(fx, { status: "ORDERED", items: [{ quantity: 5, receivedQuantity: 0 }], orderedAt: "2026-09-15T00:00:00.000Z" });
  await makePo(fx, { status: "CANCELLED", items: [{ quantity: 2 }] });

  const s = await computeSupplierScorecard({ orgId: fx.orgIdStr, supplierId: fx.supplierId.toString(), membership: OWNER });
  assert.equal(s.totalOrders, 4);
  assert.equal(s.fillRate.percent, 75, "15 received of 20 ordered across the 3 ordered-or-later POs");
  assert.equal(s.fillRate.sample, 3);
  assert.equal(s.onTimeRate.percent, 50);
  assert.equal(s.onTimeRate.sample, 2);
  assert.equal(s.averageLeadTimeDays.days, 8.5);
  assert.equal(s.cancellationRate.percent, 25);
});

test("scorecard: a supplier with no orders reports no numbers rather than invented ones", async () => {
  const fx = await makeOrg("empty");
  const s = await computeSupplierScorecard({ orgId: fx.orgIdStr, supplierId: fx.supplierId.toString(), membership: OWNER });
  assert.equal(s.totalOrders, 0);
  assert.equal(s.fillRate.percent, null);
  assert.equal(s.onTimeRate.percent, null);
  assert.equal(s.averageLeadTimeDays.days, null);
  assert.equal(s.cancellationRate.percent, null);
});

test("scorecard: only POs in departments the caller can access are counted", async () => {
  const fx = await makeOrg("scope");
  await makePo(fx, { status: "RECEIVED", items: [{ quantity: 4, receivedQuantity: 4 }], departmentId: fx.deptA });
  await makePo(fx, { status: "CANCELLED", items: [{ quantity: 4 }], departmentId: fx.deptB });
  const memberA = { role: "member", departmentIds: [fx.deptA] };
  const s = await computeSupplierScorecard({ orgId: fx.orgIdStr, supplierId: fx.supplierId.toString(), membership: memberA });
  assert.equal(s.totalOrders, 1, "the other department's PO is invisible");
  assert.equal(s.cancellationRate.percent, 0);

  const outsider = { role: "member", departmentIds: [fx.deptB] };
  assert.equal((await computeSupplierScorecard({ orgId: fx.orgIdStr, supplierId: fx.supplierId.toString(), membership: outsider })).status, 404, "supplier in a department they can't access");
});
