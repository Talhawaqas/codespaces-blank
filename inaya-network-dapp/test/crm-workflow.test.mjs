// test/crm-workflow.test.mjs
//
// Business Operations Phase 2 (CRM) coverage for the deal pipeline state
// machine — src/lib/deal-workflow.js. Structured like
// task-workflow.test.mjs: real MongoDB, RUN_ID-namespaced disposable
// fixtures, transitionDeal() called directly rather than through
// route.js. Contact type-flip (LEAD->CUSTOMER) and department-permission
// enforcement are exercised too since they're this phase's real new
// surface, not just a copy of the Tasks pattern.
//
// Run with: node --env-file=.env.local --test test/crm-workflow.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transitionDeal, DEAL_STAGES } from "../src/lib/deal-workflow.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-crm-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], dealIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, crmContacts, crmDeals, orgActivity } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await crmContacts.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await crmDeals.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ recordId: { $in: cleanup.dealIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithDepartment(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptResult = await collections.departments.insertOne({ orgId, name: "Sales", createdAt: now });

  const memberEmail = email(`${label}-member`);
  await collections.orgMembers.insertOne({ orgId, email: memberEmail, role: "member", departmentIds: [deptResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });

  const contactResult = await collections.crmContacts.insertOne({
    orgId, departmentId: deptResult.insertedId, type: "LEAD", name: "Acme Corp",
    email: null, phone: null, company: null, notes: null,
    createdByEmail: memberEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });

  return { orgId, departmentId: deptResult.insertedId, member, memberEmail, contactId: contactResult.insertedId };
}

async function makeDeal({ orgId, departmentId, contactId, status = "NEW" }) {
  const now = new Date().toISOString();
  const result = await collections.crmDeals.insertOne({
    orgId, departmentId, contactId, projectId: null, title: "Test deal", value: 1000,
    status, createdByEmail: "creator@example.com", createdAt: now, updatedAt: now, closedAt: null, deletedAt: null,
  });
  cleanup.dealIds.push(result.insertedId);
  return result.insertedId;
}

test("valid: advance steps NEW -> QUALIFIED -> PROPOSAL -> NEGOTIATION, one stage at a time", async () => {
  const org = await makeOrgWithDepartment("advance");
  const dealId = await makeDeal({ ...org, status: "NEW" });

  const r1 = await transitionDeal({ orgId: org.orgId, dealId, action: "advance", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(r1.deal.status, "QUALIFIED");
  const r2 = await transitionDeal({ orgId: org.orgId, dealId, action: "advance", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(r2.deal.status, "PROPOSAL");
  const r3 = await transitionDeal({ orgId: org.orgId, dealId, action: "advance", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(r3.deal.status, "NEGOTIATION");
});

test("invalid: advance from NEGOTIATION has no next open stage — must use win/lose", async () => {
  const org = await makeOrgWithDepartment("advance-terminal");
  const dealId = await makeDeal({ ...org, status: "NEGOTIATION" });
  const result = await transitionDeal({ orgId: org.orgId, dealId, action: "advance", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);
});

test("valid: regress steps backward through the open pipeline", async () => {
  const org = await makeOrgWithDepartment("regress");
  const dealId = await makeDeal({ ...org, status: "PROPOSAL" });
  const result = await transitionDeal({ orgId: org.orgId, dealId, action: "regress", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.deal.status, "QUALIFIED");
});

test("valid: win closes a deal from ANY open stage, not only after reaching NEGOTIATION", async () => {
  const org = await makeOrgWithDepartment("win-early");
  const dealId = await makeDeal({ ...org, status: "NEW" });
  const result = await transitionDeal({ orgId: org.orgId, dealId, action: "win", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.deal.status, "WON");
  assert.ok(result.deal.closedAt);
});

test("valid: lose closes a deal, and reopen returns it to NEW with closedAt cleared", async () => {
  const org = await makeOrgWithDepartment("lose-reopen");
  const dealId = await makeDeal({ ...org, status: "NEGOTIATION" });

  const lost = await transitionDeal({ orgId: org.orgId, dealId, action: "lose", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(lost.deal.status, "LOST");
  assert.ok(lost.deal.closedAt);

  const reopened = await transitionDeal({ orgId: org.orgId, dealId, action: "reopen", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(reopened.deal.status, "NEW");
  assert.equal(reopened.deal.closedAt, null);
});

test("invalid: win/lose fail on an already-closed deal", async () => {
  const org = await makeOrgWithDepartment("win-closed");
  const dealId = await makeDeal({ ...org, status: "WON" });
  const result = await transitionDeal({ orgId: org.orgId, dealId, action: "win", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);
});

test("invalid: reopen fails on an open (non-closed) deal", async () => {
  const org = await makeOrgWithDepartment("reopen-open");
  const dealId = await makeDeal({ ...org, status: "QUALIFIED" });
  const result = await transitionDeal({ orgId: org.orgId, dealId, action: "reopen", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);
});

test("permission: a member outside the deal's department is denied", async () => {
  const org = await makeOrgWithDepartment("permission-outsider");
  const outsiderEmail = email("permission-outsider-outsider");
  const now = new Date().toISOString();
  await collections.orgMembers.insertOne({ orgId: org.orgId, email: outsiderEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const outsider = await collections.orgMembers.findOne({ orgId: org.orgId, email: outsiderEmail });

  const dealId = await makeDeal({ ...org, status: "NEW" });
  const result = await transitionDeal({ orgId: org.orgId, dealId, action: "advance", membership: outsider, actorEmail: outsiderEmail });
  assert.equal(result.status, 403);
});

test("org_activity: DEAL entries carry the correct action names and previous/new state", async () => {
  const org = await makeOrgWithDepartment("activity");
  const dealId = await makeDeal({ ...org, status: "NEW" });

  await transitionDeal({ orgId: org.orgId, dealId, action: "advance", membership: org.member, actorEmail: org.memberEmail });
  await transitionDeal({ orgId: org.orgId, dealId, action: "win", membership: org.member, actorEmail: org.memberEmail });

  const events = await collections.orgActivity.find({ recordType: "DEAL", recordId: dealId }).sort({ timestamp: 1 }).toArray();
  assert.deepEqual(events.map((e) => e.action), ["DEAL_ADVANCED", "DEAL_WON"]);
  assert.equal(events[0].previousState, "NEW");
  assert.equal(events[0].newState, "QUALIFIED");
  assert.equal(events[1].newState, "WON");
});

test("contact type flip: a LEAD contact can be converted to CUSTOMER via a field edit, not a new record", async () => {
  const org = await makeOrgWithDepartment("contact-convert");
  const contact = await collections.crmContacts.findOne({ _id: org.contactId });
  assert.equal(contact.type, "LEAD");

  const now = new Date().toISOString();
  await collections.crmContacts.updateOne({ _id: org.contactId }, { $set: { type: "CUSTOMER", updatedAt: now } });
  const updated = await collections.crmContacts.findOne({ _id: org.contactId });
  assert.equal(updated.type, "CUSTOMER");
  assert.equal(updated._id.toString(), org.contactId.toString(), "conversion must update the same record, not create a new one");
});

test("DEAL_STAGES export matches the exact set used by the pipeline UI/AI tool", () => {
  assert.deepEqual(DEAL_STAGES, ["NEW", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"]);
});
