// test/business-events.test.mjs
//
// Evidence Graph & Trusted Business Event Layer SOW — core Business Event
// model: creation, department/org-manager scoping, cross-org isolation,
// relationship linking with permission-aware evidence hiding, and timeline
// aggregation from real, pre-existing org_activity entries.
//
// Run with: node --env-file=.env.local --test test/business-events.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { connectToDatabase } from "../src/lib/mongodb.js";
import { createBusinessEvent, getBusinessEvent, listBusinessEvents, addBusinessEventRelationship, getBusinessEventTimeline } from "../src/lib/businessEvents.js";
import { transitionPurchaseOrder } from "../src/lib/purchase-order-workflow.js";

const RUN_ID = randomUUID().slice(0, 8);
let collections;
const cleanupOrgIds = [];

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { db } = await connectToDatabase();
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: cleanupOrgIds } }),
    collections.departments.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.orgMembers.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.suppliers.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.purchaseOrders.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.purchaseRequests.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.invoices.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.businessEvents.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.orgActivity.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.auditChainEntries.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.auditChainHeads.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    db.collection("notifications").deleteMany({ orgId: { $in: cleanupOrgIds } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const ownerEmail = `${label}-owner-${RUN_ID}@example.com`;
  const staffEmail = `${label}-staff-${RUN_ID}@example.com`;
  const orgResult = await collections.orgs.insertOne({ name: `${label} ${RUN_ID} Co`, ownerEmail, createdAt: now });
  const orgId = orgResult.insertedId;
  cleanupOrgIds.push(orgId);
  const deptResult = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const otherDeptResult = await collections.departments.insertOne({ orgId, name: "Other Dept", createdAt: now });
  const departmentId = deptResult.insertedId;
  await collections.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: staffEmail, role: "member", departmentIds: [departmentId], status: "active", invitedAt: now, joinedAt: now },
  ]);
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const staff = await collections.orgMembers.findOne({ orgId, email: staffEmail });
  return { orgId, departmentId, otherDepartmentId: otherDeptResult.insertedId, owner, staff, ownerEmail, staffEmail };
}

async function makeSupplier(org) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.suppliers.insertOne({ orgId: org.orgId, departmentId: org.departmentId, name: "Acme", status: "ACTIVE", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null });
  return insertedId;
}

async function makePO(org, { departmentId = org.departmentId, status = "DRAFT" } = {}) {
  const now = new Date().toISOString();
  const supplierId = await makeSupplier(org);
  const { insertedId } = await collections.purchaseOrders.insertOne({
    orgId: org.orgId, departmentId, supplierId, sourceRequestId: null,
    items: [{ description: "Widgets", sku: null, productId: null, warehouseId: null, quantity: 10, unitPrice: 2500, receivedQuantity: 0 }],
    currency: "USD", status, createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });
  return insertedId;
}

async function makeInvoice(org, { departmentId = org.departmentId, total = 25000 } = {}) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.invoices.insertOne({
    orgId: org.orgId, departmentId, contactId: org.orgId, invoiceNumber: `INV-${RUN_ID}`, issueDate: now, dueDate: now,
    lineItems: [], subtotal: total, total, currency: "USD", status: "DRAFT", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });
  return insertedId;
}

test("createBusinessEvent references the subject without copying it, and computes risk from the real classifier", async () => {
  const org = await makeOrg("create");
  const invoiceId = await makeInvoice(org, { total: 25000 });

  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "INVOICE", subjectId: invoiceId, membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(event.subjectType, "INVOICE");
  assert.equal(event.subjectId.toString(), invoiceId.toString());
  assert.equal(event.riskLevel, "HIGH", "invoices are HIGH risk per ai-action-requests.js's own RISK_LEVELS table");
  assert.equal(event.status, "OPEN");
  assert.equal(event.subjectSummary.amount, 25000);

  // Never copies the invoice body itself.
  const raw = await collections.businessEvents.findOne({ _id: event._id });
  assert.equal(raw.lineItems, undefined);
  assert.equal(raw.invoiceNumber, undefined);
});

test("a department-scoped member without access to the subject's department cannot create or view the event", async () => {
  const org = await makeOrg("dept-scope");
  const poId = await makePO(org, { departmentId: org.otherDepartmentId });

  const created = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.staff, actorEmail: org.staffEmail });
  assert.equal(created.status, 403, "staff has no access to otherDepartmentId, so creation must be rejected");

  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail });
  const viewAttempt = await getBusinessEvent({ orgId: org.orgId, eventId: event._id, membership: org.staff });
  assert.equal(viewAttempt.status, 403);

  const list = await listBusinessEvents({ orgId: org.orgId, membership: org.staff });
  assert.ok(!list.some((e) => e._id.toString() === event._id.toString()), "staff must not see an event scoped to a department they can't access");
});

test("cross-org isolation: an event created in org A is invisible and unfetchable from org B", async () => {
  const orgA = await makeOrg("cross-a");
  const orgB = await makeOrg("cross-b");
  const poId = await makePO(orgA);
  const { event } = await createBusinessEvent({ orgId: orgA.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: orgA.owner, actorEmail: orgA.ownerEmail });

  const got = await getBusinessEvent({ orgId: orgB.orgId, eventId: event._id, membership: orgB.owner });
  assert.equal(got.status, 404, "an event's orgId filter must prevent cross-org lookup even with a valid orgB owner membership");

  const listInB = await listBusinessEvents({ orgId: orgB.orgId, membership: orgB.owner });
  assert.ok(!listInB.some((e) => e._id.toString() === event._id.toString()));
});

test("relationships are permission-aware: a staff member without access to a linked department's supplier gets RESTRICTED, not the record", async () => {
  const org = await makeOrg("evidence-restrict");
  const poId = await makePO(org, { departmentId: org.departmentId });
  const restrictedSupplierId = await (async () => {
    const now = new Date().toISOString();
    const { insertedId } = await collections.suppliers.insertOne({ orgId: org.orgId, departmentId: org.otherDepartmentId, name: "Hidden Supplier", status: "ACTIVE", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null });
    return insertedId;
  })();

  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail });
  const added = await addBusinessEventRelationship({ orgId: org.orgId, eventId: event._id, membership: org.owner, actorEmail: org.ownerEmail, type: "REFERENCES", targetType: "SUPPLIER", targetId: restrictedSupplierId });
  assert.ok(added.ok);

  const { explainBusinessEvent } = await import("../src/lib/businessEventExplain.js");
  const staffView = await explainBusinessEvent({ orgId: org.orgId, eventId: event._id, membership: org.staff });
  assert.equal(staffView.error, undefined, "staff can see the event itself — it's scoped to their own department");
  const supplierEvidence = staffView.explanation.sourceEvidence.find((e) => e.targetType === "SUPPLIER");
  assert.equal(supplierEvidence.state, "RESTRICTED");
  assert.equal(supplierEvidence.label, undefined, "a RESTRICTED item must never leak the record's own name/label");

  const ownerView = await explainBusinessEvent({ orgId: org.orgId, eventId: event._id, membership: org.owner });
  const ownerSupplierEvidence = ownerView.explanation.sourceEvidence.find((e) => e.targetType === "SUPPLIER");
  assert.equal(ownerSupplierEvidence.state, "INCLUDED");
  assert.equal(ownerSupplierEvidence.label, "Hidden Supplier");
});

test("timeline merges real org_activity from the event and its subject, in chronological order", async () => {
  const org = await makeOrg("timeline");
  const poId = await makePO(org);
  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail });

  // Drives a REAL transition on the subject via the real workflow function
  // — not a fixture insert — so the timeline is proven to pick up genuine
  // activity, not just what businessEvents.js itself wrote.
  const submitResult = await transitionPurchaseOrder({ orgId: org.orgId, poId, action: "submit", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(submitResult.error, undefined);

  const { timeline } = await getBusinessEventTimeline({ orgId: org.orgId, eventId: event._id, membership: org.owner });
  assert.ok(timeline.some((t) => t.recordType === "BUSINESS_EVENT" && t.action === "EVENT_CREATED"));
  assert.ok(timeline.some((t) => t.recordType === "PURCHASE_ORDER" && t.action === "PO_SUBMITTED"), "the real PO_SUBMITTED activity entry must appear in the event's timeline");
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(new Date(timeline[i].timestamp) >= new Date(timeline[i - 1].timestamp), "timeline must be chronologically sorted");
  }
});

test("a HIGH-risk event notifies other org managers, but never the creator themselves", async () => {
  const org = await makeOrg("notify");
  const now = new Date().toISOString();
  const secondAdminEmail = `notify-admin2-${RUN_ID}@example.com`;
  await collections.orgMembers.insertOne({ orgId: org.orgId, email: secondAdminEmail, role: "admin", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });

  const invoiceId = await makeInvoice(org, { total: 50000 });
  await createBusinessEvent({ orgId: org.orgId, subjectType: "INVOICE", subjectId: invoiceId, membership: org.owner, actorEmail: org.ownerEmail });

  const { db } = await connectToDatabase();
  const notifs = await db.collection("notifications").find({ orgId: org.orgId, type: "business_event_high_risk" }).toArray();
  assert.ok(notifs.some((n) => n.targetEmail === secondAdminEmail), "the second admin (not the creator) must be notified of a HIGH-risk event");
  assert.ok(!notifs.some((n) => n.targetEmail === org.ownerEmail), "the creator must not be notified of their own event");
});
