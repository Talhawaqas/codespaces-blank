// test/institutional-attention.test.mjs
//
// Institutional Trust Infrastructure SOW, Phase 3 coverage: getAttentionItems()
// only ever surfaces items the caller was independently already permitted
// to see (each source re-derives its own real gate -- resolveCanApprove
// for AI action requests, ctx.scope for business tasks/documents), cross-org
// isolation, and that every item carries a real underlying record reference.
//
// Same fixture conventions as task-workflow.test.mjs/ai-action-requests.test.mjs.
//
// Run with: node --env-file=.env.local --test test/institutional-attention.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { buildBusinessContext } from "../src/lib/ai-business-tools.js";
import { proposeAiAction } from "../src/lib/ai-action-requests.js";
import { getAttentionItems } from "../src/lib/institutional-attention.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-attention-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, projects, tasks, orgDocuments, aiActionRequests, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await tasks.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await aiActionRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithTwoDepartments(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptA = await collections.departments.insertOne({ orgId, name: "Finance", createdAt: now });
  const projA = await collections.projects.insertOne({ orgId, departmentId: deptA.insertedId, name: "Q3", createdAt: now });
  const deptB = await collections.departments.insertOne({ orgId, name: "Legal", createdAt: now });
  const projB = await collections.projects.insertOne({ orgId, departmentId: deptB.insertedId, name: "Contracts", createdAt: now });

  const ownerEmail = email(`${label}-owner`);
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  const memberEmail = email(`${label}-member`);
  await collections.orgMembers.insertOne({ orgId, email: memberEmail, role: "member", departmentIds: [deptA.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });

  return { orgId, deptAId: deptA.insertedId, projAId: projA.insertedId, deptBId: deptB.insertedId, projBId: projB.insertedId, owner, member, ownerEmail, memberEmail };
}

async function makeTask({ orgId, departmentId, projectId, dueDate, title, assigneeEmail = null }) {
  const now = new Date().toISOString();
  const result = await collections.tasks.insertOne({
    orgId, departmentId, projectId, title, status: "IN_PROGRESS", priority: "MEDIUM",
    assigneeEmail, dueDate, createdAt: now, updatedAt: now,
  });
  return result.insertedId;
}

async function makeDocument({ orgId, departmentId, projectId, status, filename = "attention-test.pdf" }) {
  const now = new Date().toISOString();
  const result = await collections.orgDocuments.insertOne({
    orgId, departmentId, projectId, filename, fileHash: `0xattn-${randomUUID()}`,
    sizeBytes: 1024, cidAlpha: "cidA", cidBeta: "cidB", uploadedByEmail: "uploader@example.com",
    txHash: "0xfake", status, createdAt: now, deletedAt: null,
  });
  return result.insertedId;
}

test("getAttentionItems: surfaces the caller's own overdue task and pending document, each with a real reference", async () => {
  const org = await makeOrgWithTwoDepartments("core");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await makeTask({ orgId: org.orgId, departmentId: org.deptAId, projectId: org.projAId, dueDate: yesterday, title: "Overdue in my dept", assigneeEmail: org.memberEmail });
  await makeDocument({ orgId: org.orgId, departmentId: org.deptAId, projectId: org.projAId, status: "PENDING" });

  const ctx = await buildBusinessContext({ orgId: org.orgId, membership: org.member, email: org.memberEmail });
  const { items } = await getAttentionItems({ orgId: org.orgId, membership: org.member, email: org.memberEmail, businessCtx: ctx });

  const taskItem = items.find((i) => i.recordType === "TASK");
  assert.ok(taskItem, "overdue task should appear");
  assert.match(taskItem.title, /Overdue in my dept/);

  const docItem = items.find((i) => i.recordType === "DOCUMENT");
  assert.ok(docItem, "pending document should appear");
  assert.match(docItem.title, /attention-test\.pdf/);
});

test("PERMISSION BOUNDARY: a task/document in a department the caller can't access never appears, even though the owner sees the document org-wide", async () => {
  const org = await makeOrgWithTwoDepartments("boundary");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await makeTask({ orgId: org.orgId, departmentId: org.deptBId, projectId: org.projBId, dueDate: yesterday, title: "Overdue but inaccessible", assigneeEmail: org.memberEmail });
  await makeDocument({ orgId: org.orgId, departmentId: org.deptBId, projectId: org.projBId, status: "UNDER_REVIEW", filename: "inaccessible.pdf" });

  const memberCtx = await buildBusinessContext({ orgId: org.orgId, membership: org.member, email: org.memberEmail });
  const memberResult = await getAttentionItems({ orgId: org.orgId, membership: org.member, email: org.memberEmail, businessCtx: memberCtx });
  assert.ok(!memberResult.items.some((i) => i.title.includes("inaccessible")), "a member must never see attention items from a department they can't access");

  // The owner's OWN overdue-tasks slice is (by design) assignee-scoped --
  // "what needs MY attention" reasonably means MY tasks, not every task
  // org-wide -- so the department-boundary check for the owner uses the
  // document instead, which is department-scoped with no assignee filter,
  // and the owner (canManageOrg) sees every department.
  const ownerCtx = await buildBusinessContext({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  const ownerResult = await getAttentionItems({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, businessCtx: ownerCtx });
  assert.ok(ownerResult.items.some((i) => i.title.includes("inaccessible.pdf")), "the owner/admin should still see the document org-wide");
});

test("PERMISSION BOUNDARY: an AI action request only appears for someone who could approve the real action, via the real gate", async () => {
  const org = await makeOrgWithTwoDepartments("ai-gate");
  const taskId = await makeTask({ orgId: org.orgId, departmentId: org.deptAId, projectId: org.projAId, dueDate: null, title: "Task behind an AI proposal" });

  const { request } = await proposeAiAction({
    orgId: org.orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: taskId, proposedAction: "start",
    args: { taskId: taskId.toString(), action: "start" },
    requestedContextSummary: "test proposal", actorEmail: org.memberEmail, canPropose: true,
  });
  assert.equal(request.status, "PENDING_APPROVAL");

  // Member IS in deptA (task's department) -- TASK approval only requires
  // canAccessDepartment, so this should appear for them.
  const memberCtx = await buildBusinessContext({ orgId: org.orgId, membership: org.member, email: org.memberEmail });
  const memberResult = await getAttentionItems({ orgId: org.orgId, membership: org.member, email: org.memberEmail, businessCtx: memberCtx });
  const aiItem = memberResult.items.find((i) => i.sourceModule === "ai-action-requests");
  assert.ok(aiItem, "a member with department access should see the pending AI proposal");
  assert.equal(aiItem.recordType, "TASK");
  assert.equal(aiItem.recordId, taskId.toString(), "must carry the real underlying record id");
});

test("SECURITY: cross-org isolation -- attention items from org A never leak into org B's result", async () => {
  const orgA = await makeOrgWithTwoDepartments("cross-a");
  const orgB = await makeOrgWithTwoDepartments("cross-b");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await makeTask({ orgId: orgA.orgId, departmentId: orgA.deptAId, projectId: orgA.projAId, dueDate: yesterday, title: "Org A overdue task", assigneeEmail: orgA.memberEmail });

  const ctxB = await buildBusinessContext({ orgId: orgB.orgId, membership: orgB.owner, email: orgB.ownerEmail });
  const resultB = await getAttentionItems({ orgId: orgB.orgId, membership: orgB.owner, email: orgB.ownerEmail, businessCtx: ctxB });
  assert.ok(!resultB.items.some((i) => i.title.includes("Org A overdue task")), "org B's attention feed must never include org A's data");
});
