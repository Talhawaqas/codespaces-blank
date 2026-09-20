// test/business-event-simulate.test.mjs
//
// Evidence Graph SOW §18/§32 — What If / Simulation. This is the SOW's
// explicitly named strongest acceptance test: "a simulation request must
// NEVER execute the real action." Every test below snapshots the subject
// document BEFORE calling simulateBusinessEventDecision() and asserts it
// is byte-identical (via deep-equal on the full raw Mongo document)
// AFTER — for both a legal and an authorized "approve" simulation, which
// is exactly the case most likely to accidentally trigger a real write if
// this module ever imported the real transition function instead of its
// state table.
//
// Run with: node --env-file=.env.local --test test/business-event-simulate.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createBusinessEvent } from "../src/lib/businessEvents.js";
import { simulateBusinessEventDecision } from "../src/lib/businessEventSimulate.js";

const RUN_ID = randomUUID().slice(0, 8);
let collections;
const cleanupOrgIds = [];

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: cleanupOrgIds } }),
    collections.departments.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.orgMembers.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.suppliers.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.purchaseOrders.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.aiActionRequests.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.businessEvents.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.orgActivity.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.auditChainEntries.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.auditChainHeads.deleteMany({ orgId: { $in: cleanupOrgIds } }),
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
  const departmentId = deptResult.insertedId;
  await collections.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: staffEmail, role: "member", departmentIds: [departmentId], status: "active", invitedAt: now, joinedAt: now },
  ]);
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const staff = await collections.orgMembers.findOne({ orgId, email: staffEmail });
  return { orgId, departmentId, owner, staff, ownerEmail, staffEmail };
}

async function makePendingPO(org) {
  const now = new Date().toISOString();
  const { insertedId: supplierId } = await collections.suppliers.insertOne({ orgId: org.orgId, departmentId: org.departmentId, name: "Acme", status: "ACTIVE", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null });
  const { insertedId: poId } = await collections.purchaseOrders.insertOne({
    orgId: org.orgId, departmentId: org.departmentId, supplierId, sourceRequestId: null,
    items: [{ description: "Widgets", sku: null, productId: null, warehouseId: null, quantity: 10, unitPrice: 2500, receivedQuantity: 0 }],
    currency: "USD", status: "PENDING_APPROVAL", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });
  return poId;
}

async function makePendingAiAction(org) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.aiActionRequests.insertOne({
    orgId: org.orgId, assistantSurface: "business", toolName: "propose_test", targetRecordType: "TASK", targetRecordId: null,
    proposedAction: "complete", args: {}, requestedContextSummary: "test", riskLevel: "MEDIUM", status: "PENDING_APPROVAL",
    requestedByEmail: org.ownerEmail, requestedAt: now, proposalExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    reviewedByEmail: null, reviewedAt: null, reviewNote: null, unlockAt: null, executedAt: null, idempotencyKey: `sim-test-${RUN_ID}`,
  });
  return insertedId;
}

test("simulating a legal, authorized PO approval never mutates the PO document", async () => {
  const org = await makeOrg("sim-po");
  const poId = await makePendingPO(org);
  const before = await collections.purchaseOrders.findOne({ _id: poId });

  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail });
  const { simulation } = await simulateBusinessEventDecision({ orgId: org.orgId, eventId: event._id, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });

  assert.equal(simulation.simulationOnly, true);
  assert.equal(simulation.noChangesWereMade, true);
  assert.equal(simulation.legal, true);
  assert.equal(simulation.authorized, true);
  assert.equal(simulation.currentState, "PENDING_APPROVAL");
  assert.equal(simulation.targetState, "APPROVED");

  const after = await collections.purchaseOrders.findOne({ _id: poId });
  assert.deepEqual(after, before, "the PO document must be byte-identical before and after a simulation — simulate must never call the real transition");
  assert.equal(after.status, "PENDING_APPROVAL", "status must remain unchanged");
});

test("simulating an approval a staff member isn't authorized for reports authorized:false without mutating anything", async () => {
  const org = await makeOrg("sim-unauth");
  const poId = await makePendingPO(org);
  const before = await collections.purchaseOrders.findOne({ _id: poId });

  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail });
  const { simulation } = await simulateBusinessEventDecision({ orgId: org.orgId, eventId: event._id, action: "approve", membership: org.staff, actorEmail: org.staffEmail });

  assert.equal(simulation.legal, true, "the transition itself is legal from this state");
  assert.equal(simulation.authorized, false, "staff lacks requiresManage authority for PO approval");

  const after = await collections.purchaseOrders.findOne({ _id: poId });
  assert.deepEqual(after, before);
});

test("simulating an illegal transition (approving an already-approved PO) reports legal:false and cites the real current state", async () => {
  const org = await makeOrg("sim-illegal");
  const poId = await makePendingPO(org);
  await collections.purchaseOrders.updateOne({ _id: poId }, { $set: { status: "APPROVED" } });
  const before = await collections.purchaseOrders.findOne({ _id: poId });

  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail });
  const { simulation } = await simulateBusinessEventDecision({ orgId: org.orgId, eventId: event._id, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });

  assert.equal(simulation.legal, false);
  assert.equal(simulation.currentState, "APPROVED");
  assert.match(simulation.reason, /PENDING_APPROVAL/);

  const after = await collections.purchaseOrders.findOne({ _id: poId });
  assert.deepEqual(after, before);
});

test("simulating an AI action approval computes the real 36h settlement delay without touching the request", async () => {
  const org = await makeOrg("sim-ai");
  const aiId = await makePendingAiAction(org);
  const before = await collections.aiActionRequests.findOne({ _id: aiId });

  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "AI_ACTION_REQUEST", subjectId: aiId, membership: org.owner, actorEmail: org.ownerEmail });
  const { simulation } = await simulateBusinessEventDecision({ orgId: org.orgId, eventId: event._id, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });

  assert.equal(simulation.legal, true);
  assert.equal(simulation.targetState, "APPROVED");
  assert.ok(simulation.expectedUnlockAt, "an approve simulation must compute the expected 36h unlock time");
  const hoursUntilUnlock = (new Date(simulation.expectedUnlockAt) - Date.now()) / (60 * 60 * 1000);
  assert.ok(hoursUntilUnlock > 35.9 && hoursUntilUnlock < 36.1, `expected ~36h delay, got ${hoursUntilUnlock}h`);

  const after = await collections.aiActionRequests.findOne({ _id: aiId });
  assert.deepEqual(after, before, "the AI action request must remain byte-identical — status must still be PENDING_APPROVAL, unlockAt must still be null");
  assert.equal(after.status, "PENDING_APPROVAL");
  assert.equal(after.unlockAt, null);
});

test("a simulation logs SIMULATION_RUN against the BUSINESS_EVENT record, never against the subject's own recordType", async () => {
  const org = await makeOrg("sim-audit");
  const poId = await makePendingPO(org);
  const { event } = await createBusinessEvent({ orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail });
  await simulateBusinessEventDecision({ orgId: org.orgId, eventId: event._id, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });

  const eventAudit = await collections.orgActivity.findOne({ orgId: org.orgId, recordType: "BUSINESS_EVENT", recordId: event._id, action: "SIMULATION_RUN" });
  assert.ok(eventAudit, "SIMULATION_RUN must be logged against the BUSINESS_EVENT record");

  const poAudit = await collections.orgActivity.findOne({ orgId: org.orgId, recordType: "PURCHASE_ORDER", recordId: poId, action: "SIMULATION_RUN" });
  assert.equal(poAudit, null, "a simulation must never write an activity entry against the subject's own recordType/recordId — that would be indistinguishable from a real transition in the PO's own history");

  const realPoAudit = await collections.orgActivity.findOne({ orgId: org.orgId, recordType: "PURCHASE_ORDER", recordId: poId, action: "PO_APPROVED" });
  assert.equal(realPoAudit, null, "no real PO_APPROVED entry must ever be written by a simulation");
});

test("unmodeled effects are surfaced for every relationship on the event, never silently dropped", async () => {
  const org = await makeOrg("sim-unmodeled");
  const poId = await makePendingPO(org);
  const { insertedId: supplierId } = await collections.suppliers.insertOne({ orgId: org.orgId, departmentId: org.departmentId, name: "Linked Supplier", status: "ACTIVE", createdByEmail: org.ownerEmail, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null });
  const { event } = await createBusinessEvent({
    orgId: org.orgId, subjectType: "PURCHASE_ORDER", subjectId: poId, membership: org.owner, actorEmail: org.ownerEmail,
    relationships: [{ type: "RELATES_TO", targetType: "SUPPLIER", targetId: supplierId }],
  });

  const { simulation } = await simulateBusinessEventDecision({ orgId: org.orgId, eventId: event._id, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(simulation.unmodeledEffects.length, 1);
  assert.equal(simulation.unmodeledEffects[0].type, "SUPPLIER");
  assert.equal(simulation.unmodeledEffects[0].targetId, String(supplierId));
});
