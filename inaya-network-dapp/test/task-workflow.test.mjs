// test/task-workflow.test.mjs
//
// Business Operations Phase 1 (Tasks) coverage: every valid transition,
// invalid transitions, department-level permission enforcement, org
// isolation, atomicity/replay-safety, org_activity correctness,
// getAccessibleScope()'s visibleTasks, and the list_tasks AI tool's
// permission scoping.
//
// Structured exactly like document-workflow.test.mjs: calls
// transitionTask()/logOrgActivity() (src/lib/task-workflow.js,
// src/lib/org-activity-log.js) directly rather than importing route.js —
// the routes are thin auth+param wrappers around these, and importing
// route.js pulls in next/server, which plain `node --test` can't resolve
// outside Next's own bundler. Task fixtures are inserted directly into
// the `tasks` collection rather than going through the create route.
//
// Run with: node --env-file=.env.local --test test/task-workflow.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transitionTask, TASK_STATES } from "../src/lib/task-workflow.js";
import { getAccessibleScope } from "../src/lib/document-permissions.js";
import { buildBusinessContext, runBusinessTool } from "../src/lib/ai-business-tools.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-tasks-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], taskIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, projects, tasks, orgActivity } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await tasks.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ recordId: { $in: cleanup.taskIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

// ============================================================
// Fixtures
// ============================================================
async function makeOrgWithDepartment(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptResult = await collections.departments.insertOne({ orgId, name: "Finance", createdAt: now });
  const projResult = await collections.projects.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Q3", createdAt: now });

  const ownerEmail = email(`${label}-owner`);
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  const memberEmail = email(`${label}-member`);
  await collections.orgMembers.insertOne({ orgId, email: memberEmail, role: "member", departmentIds: [deptResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });

  return { orgId, departmentId: deptResult.insertedId, projectId: projResult.insertedId, owner, member, ownerEmail, memberEmail };
}

async function makeTask({ orgId, departmentId, projectId, status = "TODO", assigneeEmail = null, dueDate = null, priority = "MEDIUM", title = "Test task" }) {
  const now = new Date().toISOString();
  const result = await collections.tasks.insertOne({
    orgId, departmentId, projectId, title, description: null, status, priority,
    assigneeEmail, dueDate, createdByEmail: "creator@example.com",
    createdAt: now, updatedAt: now, completedAt: null, deletedAt: null,
  });
  cleanup.taskIds.push(result.insertedId);
  return result.insertedId;
}

async function getTaskActivity(taskId) {
  return collections.orgActivity.find({ recordType: "TASK", recordId: taskId }).sort({ timestamp: 1 }).toArray();
}

// ============================================================
// Valid transitions
// ============================================================
test("valid transition: start moves TODO -> IN_PROGRESS", async () => {
  const org = await makeOrgWithDepartment("valid-start");
  const taskId = await makeTask({ ...org, status: "TODO" });

  const result = await transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.error, undefined);
  assert.equal(result.task.status, "IN_PROGRESS");
});

test("valid transition: block <-> resume round-trips IN_PROGRESS -> BLOCKED -> IN_PROGRESS", async () => {
  const org = await makeOrgWithDepartment("valid-block-resume");
  const taskId = await makeTask({ ...org, status: "IN_PROGRESS" });

  const blocked = await transitionTask({ orgId: org.orgId, taskId, action: "block", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(blocked.task.status, "BLOCKED");

  const resumed = await transitionTask({ orgId: org.orgId, taskId, action: "resume", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(resumed.task.status, "IN_PROGRESS");
});

test("valid transition: complete <-> reopen round-trips IN_PROGRESS -> DONE -> IN_PROGRESS, setting/clearing completedAt", async () => {
  const org = await makeOrgWithDepartment("valid-complete-reopen");
  const taskId = await makeTask({ ...org, status: "IN_PROGRESS" });

  const completed = await transitionTask({ orgId: org.orgId, taskId, action: "complete", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(completed.task.status, "DONE");
  assert.ok(completed.task.completedAt, "completedAt must be set on completion");

  const reopened = await transitionTask({ orgId: org.orgId, taskId, action: "reopen", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(reopened.task.status, "IN_PROGRESS");
  assert.equal(reopened.task.completedAt, null, "completedAt must be cleared on reopen");
});

test("valid transition: cancel succeeds from each of its 3 allowed starting states", async () => {
  const org = await makeOrgWithDepartment("valid-cancel");
  for (const status of ["TODO", "IN_PROGRESS", "BLOCKED"]) {
    const taskId = await makeTask({ ...org, status });
    const result = await transitionTask({ orgId: org.orgId, taskId, action: "cancel", membership: org.member, actorEmail: org.memberEmail });
    assert.equal(result.task.status, "CANCELLED", `cancel should succeed from ${status}`);
  }
});

// ============================================================
// Invalid transitions
// ============================================================
test("invalid transition: complete fails when task is not IN_PROGRESS (e.g. still TODO)", async () => {
  const org = await makeOrgWithDepartment("invalid-wrong-state");
  const taskId = await makeTask({ ...org, status: "TODO" });

  const result = await transitionTask({ orgId: org.orgId, taskId, action: "complete", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);

  const task = await collections.tasks.findOne({ _id: taskId });
  assert.equal(task.status, "TODO", "state must be unchanged after a rejected transition");
});

test("invalid transition: cancel fails once a task is already DONE", async () => {
  const org = await makeOrgWithDepartment("invalid-cancel-done");
  const taskId = await makeTask({ ...org, status: "DONE" });

  const result = await transitionTask({ orgId: org.orgId, taskId, action: "cancel", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);
});

test("invalid transition: unknown action name is rejected with 400", async () => {
  const org = await makeOrgWithDepartment("invalid-unknown");
  const taskId = await makeTask({ ...org, status: "TODO" });

  const result = await transitionTask({ orgId: org.orgId, taskId, action: "deleteForever", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 400);
});

// ============================================================
// Department-level permission
// ============================================================
test("permission: a member outside the task's department is denied every transition", async () => {
  const org = await makeOrgWithDepartment("permission-outsider");
  const outsiderEmail = email("permission-outsider-outsider");
  const now = new Date().toISOString();
  await collections.orgMembers.insertOne({ orgId: org.orgId, email: outsiderEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const outsider = await collections.orgMembers.findOne({ orgId: org.orgId, email: outsiderEmail });

  const taskId = await makeTask({ ...org, status: "TODO" });
  const result = await transitionTask({ orgId: org.orgId, taskId, action: "start", membership: outsider, actorEmail: outsiderEmail });
  assert.equal(result.status, 403);

  const task = await collections.tasks.findOne({ _id: taskId });
  assert.equal(task.status, "TODO");
});

test("permission: a member inside the department succeeds regardless of who's assigned", async () => {
  const org = await makeOrgWithDepartment("permission-non-assignee");
  const taskId = await makeTask({ ...org, status: "TODO", assigneeEmail: "someone-else@example.com" });

  const result = await transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.error, undefined, "department access is sufficient — task-workflow.js has no per-assignee gate");
  assert.equal(result.task.status, "IN_PROGRESS");
});

// ============================================================
// Organization isolation
// ============================================================
test("organization isolation: a task from org A is invisible to a member of org B", async () => {
  const orgA = await makeOrgWithDepartment("isolation-a");
  const orgB = await makeOrgWithDepartment("isolation-b");
  const taskInA = await makeTask({ ...orgA, status: "TODO" });

  const result = await transitionTask({ orgId: orgB.orgId, taskId: taskInA, action: "start", membership: orgB.owner, actorEmail: orgB.ownerEmail });
  assert.equal(result.status, 404, "the task must not be found when queried under the wrong org");

  const task = await collections.tasks.findOne({ _id: taskInA });
  assert.equal(task.status, "TODO", "cross-org access attempt must not have changed anything");
});

// ============================================================
// Atomicity / replay safety
// ============================================================
test("replay: firing the same transition twice fails cleanly the second time, with only one activity entry", async () => {
  const org = await makeOrgWithDepartment("replay-request");
  const taskId = await makeTask({ ...org, status: "TODO" });

  const first = await transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(first.task.status, "IN_PROGRESS");

  const replay = await transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(replay.status, 409, "the replayed request must be rejected, not silently reapplied");

  const events = await getTaskActivity(taskId);
  assert.equal(events.length, 1, "the replay must not have logged a second activity entry");
});

test("atomicity: two concurrent start calls on the same TODO task — exactly one succeeds", async () => {
  const org = await makeOrgWithDepartment("concurrent-request");
  const taskId = await makeTask({ ...org, status: "TODO" });

  const [a, b] = await Promise.all([
    transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail }),
    transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail }),
  ]);
  const results = [a, b];
  assert.equal(results.filter((r) => !r.error).length, 1, "exactly one of the two concurrent starts should win");
  assert.equal(results.filter((r) => r.error).length, 1);

  const events = await getTaskActivity(taskId);
  assert.equal(events.length, 1, "concurrent duplicate starts must still only produce one activity entry");
});

// ============================================================
// org_activity: correctness + ordering
// ============================================================
test("org_activity: a successful transition creates exactly one correctly-shaped entry", async () => {
  const org = await makeOrgWithDepartment("activity-fields");
  const taskId = await makeTask({ ...org, status: "TODO" });

  await transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail, note: "beginning work" });

  const events = await getTaskActivity(taskId);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.ok(e.eventId);
  assert.equal(e.recordType, "TASK");
  assert.equal(e.recordId.toString(), taskId.toString());
  assert.equal(e.orgId.toString(), org.orgId.toString());
  assert.equal(e.actorEmail, org.memberEmail);
  assert.equal(e.action, "TASK_STARTED");
  assert.equal(e.previousState, "TODO");
  assert.equal(e.newState, "IN_PROGRESS");
  assert.ok(e.timestamp);
  assert.equal(e.metadata.note, "beginning work");
});

test("org_activity: entries come back in chronological order across multiple transitions", async () => {
  const org = await makeOrgWithDepartment("activity-order");
  const taskId = await makeTask({ ...org, status: "TODO" });

  await transitionTask({ orgId: org.orgId, taskId, action: "start", membership: org.member, actorEmail: org.memberEmail });
  await transitionTask({ orgId: org.orgId, taskId, action: "block", membership: org.member, actorEmail: org.memberEmail });
  await transitionTask({ orgId: org.orgId, taskId, action: "resume", membership: org.member, actorEmail: org.memberEmail });
  await transitionTask({ orgId: org.orgId, taskId, action: "complete", membership: org.member, actorEmail: org.memberEmail });

  const events = await getTaskActivity(taskId);
  assert.deepEqual(events.map((e) => e.action), ["TASK_STARTED", "TASK_BLOCKED", "TASK_RESUMED", "TASK_COMPLETED"]);
  const timestamps = events.map((e) => new Date(e.timestamp).getTime());
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b));
});

// ============================================================
// getAccessibleScope()'s visibleTasks
// ============================================================
test("visibleTasks: department-scoped exactly like visibleProjects/visibleDocuments", async () => {
  const org = await makeOrgWithDepartment("scope-tasks");
  const otherDeptResult = await collections.departments.insertOne({ orgId: org.orgId, name: "Legal", createdAt: new Date().toISOString() });
  const otherProjResult = await collections.projects.insertOne({ orgId: org.orgId, departmentId: otherDeptResult.insertedId, name: "Contracts", createdAt: new Date().toISOString() });

  const visibleTaskId = await makeTask({ orgId: org.orgId, departmentId: org.departmentId, projectId: org.projectId, status: "TODO" });
  const hiddenTaskId = await makeTask({ orgId: org.orgId, departmentId: otherDeptResult.insertedId, projectId: otherProjResult.insertedId, status: "TODO" });

  const memberScope = await getAccessibleScope({ orgId: org.orgId, membership: org.member, email: org.memberEmail });
  const memberTaskIds = memberScope.visibleTasks.map((t) => t._id.toString());
  assert.ok(memberTaskIds.includes(visibleTaskId.toString()), "member should see the task in their own department");
  assert.ok(!memberTaskIds.includes(hiddenTaskId.toString()), "member must not see the task in a department they don't have access to");

  const ownerScope = await getAccessibleScope({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  const ownerTaskIds = ownerScope.visibleTasks.map((t) => t._id.toString());
  assert.ok(ownerTaskIds.includes(visibleTaskId.toString()) && ownerTaskIds.includes(hiddenTaskId.toString()), "owner/admin should see every task org-wide");

  await collections.departments.deleteOne({ _id: otherDeptResult.insertedId });
  await collections.projects.deleteOne({ _id: otherProjResult.insertedId });
});

// ============================================================
// AI tool: list_tasks
// ============================================================
test("AI tool list_tasks: filters by overdueOnly and never surfaces tasks from an inaccessible department", async () => {
  const org = await makeOrgWithDepartment("ai-list-tasks");
  const otherDeptResult = await collections.departments.insertOne({ orgId: org.orgId, name: "Legal", createdAt: new Date().toISOString() });
  const otherProjResult = await collections.projects.insertOne({ orgId: org.orgId, departmentId: otherDeptResult.insertedId, name: "Contracts", createdAt: new Date().toISOString() });

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await makeTask({ orgId: org.orgId, departmentId: org.departmentId, projectId: org.projectId, status: "IN_PROGRESS", dueDate: yesterday, title: "Overdue in my dept" });
  await makeTask({ orgId: org.orgId, departmentId: org.departmentId, projectId: org.projectId, status: "IN_PROGRESS", dueDate: nextWeek, title: "Not due yet" });
  await makeTask({ orgId: org.orgId, departmentId: otherDeptResult.insertedId, projectId: otherProjResult.insertedId, status: "IN_PROGRESS", dueDate: yesterday, title: "Overdue but inaccessible" });

  const ctx = await buildBusinessContext({ orgId: org.orgId, membership: org.member, email: org.memberEmail });

  const overdueResult = await runBusinessTool("list_tasks", { overdueOnly: true }, ctx);
  assert.equal(overdueResult.count, 1);
  assert.equal(overdueResult.tasks[0].title, "Overdue in my dept");
  assert.ok(!overdueResult.tasks.some((t) => t.title === "Overdue but inaccessible"), "a task in an inaccessible department must never appear, regardless of what's asked");

  const allResult = await runBusinessTool("list_tasks", {}, ctx);
  assert.equal(allResult.count, 2, "both of the member's own-department tasks should be visible, still excluding the other department's task");

  await collections.departments.deleteOne({ _id: otherDeptResult.insertedId });
  await collections.projects.deleteOne({ _id: otherProjResult.insertedId });
});
