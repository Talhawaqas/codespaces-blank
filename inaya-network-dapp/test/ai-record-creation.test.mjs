// test/ai-record-creation.test.mjs
//
// Business Workspace gap closure, Batch 2 — approval-gated AI record
// creation: propose -> human approval -> 36h delay -> executor creates
// exactly one record. Unapproved or not-yet-unlocked proposals never run.
//
// Run with: node --env-file=.env.local --test test/ai-record-creation.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { proposeAiAction, reviewAiAction, executeApprovedAiActions, classifyRisk } from "../src/lib/ai-action-requests.js";
import { resolveCanApprove } from "../src/lib/ai-action-approval-gate.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (l) => `test-aicreate-${RUN_ID}-${l}@example.com`;
let c;
const cleanup = { orgIds: [] };

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  const f = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([c.orgMembers, c.departments, c.projects, c.tasks, c.crmContacts, c.aiActionRequests, c.orgActivity, c.auditChainEntries, c.auditChainHeads].map((x) => x.deleteMany(f)));
  await c.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await (await mongoClientPromise).close();
});

async function fixture() {
  const now = new Date().toISOString();
  const orgId = (await c.orgs.insertOne({ name: `aicreate-${RUN_ID}`, createdAt: now })).insertedId;
  cleanup.orgIds.push(orgId);
  const dept = (await c.departments.insertOne({ orgId, name: "Ops", createdAt: now })).insertedId;
  const other = (await c.departments.insertOne({ orgId, name: "Legal", createdAt: now })).insertedId;
  const project = (await c.projects.insertOne({ orgId, departmentId: dept, name: "Launch", createdAt: now })).insertedId;
  const m = {
    owner: { orgId, email: email("owner"), role: "owner", status: "active", departmentIds: [] },
    member: { orgId, email: email("member"), role: "member", status: "active", departmentIds: [dept] },
    legal: { orgId, email: email("legal"), role: "member", status: "active", departmentIds: [other] },
  };
  await c.orgMembers.insertMany(Object.values(m).map((x) => ({ ...x })));
  return { orgId, id: orgId.toString(), dept, project, m };
}

// Approve, then move the unlock time into the past so the executor picks it up.
async function approveAndUnlock(fx, request) {
  const r = await reviewAiAction({ orgId: fx.id, requestId: request._id, decision: "approve", actorEmail: fx.m.member.email, canApprove: true });
  assert.ok(r.request);
  await c.aiActionRequests.updateOne({ _id: request._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });
}

test("create task: approved proposal creates exactly one task, unapproved never runs", async () => {
  const fx = await fixture();
  const args = { projectId: fx.project.toString(), title: "Draft launch checklist", priority: "HIGH", assigneeEmail: fx.m.member.email };
  const { request } = await proposeAiAction({ orgId: fx.id, assistantSurface: "test", toolName: "propose_task_creation", targetRecordType: "TASK_CREATE", targetRecordId: fx.project.toString(), proposedAction: "create", args, actorEmail: fx.m.member.email, canPropose: true });
  assert.equal(classifyRisk("TASK_CREATE", "create"), "LOW");

  assert.deepEqual(await executeApprovedAiActions({ orgId: fx.id }), { claimed: 0, executed: 0, expired: 0 }, "pending proposal never executes");
  await reviewAiAction({ orgId: fx.id, requestId: request._id, decision: "approve", actorEmail: fx.m.member.email, canApprove: true });
  assert.equal((await executeApprovedAiActions({ orgId: fx.id })).claimed, 0, "approved but still inside the 36h delay");
  await c.aiActionRequests.updateOne({ _id: request._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });

  const run = await executeApprovedAiActions({ orgId: fx.id });
  assert.equal(run.executed, 1);
  assert.equal((await executeApprovedAiActions({ orgId: fx.id })).claimed, 0, "never runs twice");
  const tasks = await c.tasks.find({ orgId: fx.orgId }).toArray();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Draft launch checklist");
  assert.equal(tasks[0].status, "TODO");
  assert.equal(tasks[0].assigneeEmail, fx.m.member.email);
  assert.equal(tasks[0].createdByEmail, fx.m.member.email, "attributed to the approver");
});

test("reassign task and create contact through the same pipeline; invalid assignee expires instead of guessing", async () => {
  const fx = await fixture();
  const now = new Date().toISOString();
  const taskId = (await c.tasks.insertOne({ orgId: fx.orgId, departmentId: fx.dept, projectId: fx.project, title: "T", status: "TODO", priority: "MEDIUM", assigneeEmail: null, createdByEmail: fx.m.owner.email, deletedAt: null, createdAt: now, updatedAt: now })).insertedId;

  const good = await proposeAiAction({ orgId: fx.id, assistantSurface: "test", toolName: "propose_task_reassignment", targetRecordType: "TASK_ASSIGN", targetRecordId: taskId.toString(), proposedAction: "reassign", args: { taskId: taskId.toString(), assigneeEmail: fx.m.member.email }, actorEmail: fx.m.owner.email, canPropose: true });
  const bad = await proposeAiAction({ orgId: fx.id, assistantSurface: "test", toolName: "propose_task_reassignment", targetRecordType: "TASK_ASSIGN", targetRecordId: taskId.toString(), proposedAction: "reassign", args: { taskId: taskId.toString(), assigneeEmail: fx.m.legal.email }, actorEmail: fx.m.owner.email, canPropose: true });
  const contact = await proposeAiAction({ orgId: fx.id, assistantSurface: "test", toolName: "propose_contact_creation", targetRecordType: "CONTACT_CREATE", targetRecordId: fx.dept.toString(), proposedAction: "create", args: { departmentId: fx.dept.toString(), name: "Rhea Kim", email: "Rhea@Example.com", company: "Kim & Co" }, actorEmail: fx.m.owner.email, canPropose: true });
  for (const r of [good, bad, contact]) await approveAndUnlock(fx, r.request);

  const run = await executeApprovedAiActions({ orgId: fx.id });
  assert.equal(run.executed, 2);
  assert.equal(run.expired, 1, "assignee outside the department is refused");
  const stored = await c.aiActionRequests.findOne({ _id: bad.request._id });
  assert.match(stored.executionResult.error, /active member/);
  assert.equal((await c.tasks.findOne({ _id: taskId })).assigneeEmail, fx.m.member.email);
  const contacts = await c.crmContacts.find({ orgId: fx.orgId }).toArray();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].email, "rhea@example.com");
  assert.equal(contacts[0].type, "LEAD");
});

test("approval gate: only people with the real authority can approve creation", async () => {
  const fx = await fixture();
  const gate = (who, type, id) => resolveCanApprove({ orgId: fx.id, targetRecordType: type, targetRecordId: id, proposedAction: "create", membership: fx.m[who], email: fx.m[who].email });
  assert.equal((await gate("member", "TASK_CREATE", fx.project)).canApprove, true);
  assert.equal((await gate("legal", "TASK_CREATE", fx.project)).canApprove, false, "no access to the project's department");
  assert.equal((await gate("member", "CONTACT_CREATE", fx.dept)).canApprove, true);
  assert.equal((await gate("legal", "CONTACT_CREATE", fx.dept)).canApprove, false);
  assert.equal((await gate("owner", "CONTACT_CREATE", fx.project)).canApprove, false, "unknown department refused");

  const now = new Date().toISOString();
  const priv = (await c.tasks.insertOne({ orgId: fx.orgId, departmentId: fx.dept, projectId: fx.project, title: "Private", status: "TODO", visibility: "PRIVATE", createdByEmail: fx.m.owner.email, assigneeEmail: null, deletedAt: null, createdAt: now, updatedAt: now })).insertedId;
  assert.equal((await gate("member", "TASK_ASSIGN", priv)).canApprove, false, "private task needs record access");
  assert.equal((await gate("owner", "TASK_ASSIGN", priv)).canApprove, true);
});
