// test/task-relations.test.mjs
//
// Business Workspace gap closure, Batch 1 — subtasks, dependencies and
// recurring tasks (src/lib/task-relations.js, plus the guards and
// recurrence spawning added to task-workflow.js's transitionTask). Calls
// the library directly, like task-workflow.test.mjs, since route.js files
// import next/server.
//
// Run with: node --env-file=.env.local --test test/task-relations.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transitionTask } from "../src/lib/task-workflow.js";
import {
  nextDueDate, validateRecurrence, validateParentTask, setTaskDependencies,
  recurrenceFieldsFor, spawnNextOccurrence, getTaskRelations,
} from "../src/lib/task-relations.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-taskrel-${RUN_ID}-${label}@example.com`;
const OWNER = { role: "owner", departmentIds: [] };

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, departments, projects, tasks, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await tasks.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeProject(label) {
  const now = new Date().toISOString();
  const org = await collections.orgs.insertOne({ name: `${label} Co`, createdAt: now });
  cleanup.orgIds.push(org.insertedId);
  const dept = await collections.departments.insertOne({ orgId: org.insertedId, name: "Ops", createdAt: now });
  const project = await collections.projects.insertOne({ orgId: org.insertedId, departmentId: dept.insertedId, name: "P", createdAt: now });
  const project2 = await collections.projects.insertOne({ orgId: org.insertedId, departmentId: dept.insertedId, name: "P2", createdAt: now });
  return { orgId: org.insertedId, departmentId: dept.insertedId, projectId: project.insertedId, otherProjectId: project2.insertedId };
}

async function makeTask(fx, overrides = {}) {
  const now = new Date().toISOString();
  const doc = {
    orgId: fx.orgId, departmentId: fx.departmentId, projectId: fx.projectId,
    title: overrides.title || "Task", description: null, status: "TODO", priority: "MEDIUM",
    assigneeEmail: null, dueDate: null, createdByEmail: email("creator"),
    createdAt: now, updatedAt: now, completedAt: null, deletedAt: null, ...overrides,
  };
  const r = await collections.tasks.insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

test("nextDueDate: daily, weekly and month-end clamping that doesn't drift", () => {
  assert.equal(nextDueDate("2026-03-10", { frequency: "DAILY", interval: 1 }), "2026-03-11");
  assert.equal(nextDueDate("2026-03-10", { frequency: "WEEKLY", interval: 2 }), "2026-03-24");
  assert.equal(nextDueDate("2026-01-31", { frequency: "MONTHLY", interval: 1 }, 31), "2026-02-28");
  assert.equal(nextDueDate("2026-02-28", { frequency: "MONTHLY", interval: 1 }, 31), "2026-03-31", "anchor day restored after a short month");
  assert.equal(nextDueDate("2028-01-31", { frequency: "MONTHLY", interval: 1 }, 31), "2028-02-29", "leap year");
  assert.equal(nextDueDate("2026-11-15", { frequency: "MONTHLY", interval: 3 }), "2027-02-15", "crosses a year boundary");
  assert.equal(nextDueDate("2026-03-10T09:30:00.000Z", { frequency: "DAILY", interval: 1 }), "2026-03-11T09:30:00.000Z", "ISO input keeps ISO shape");
});

test("validateRecurrence: accepts valid input, rejects bad frequency/interval, null clears", () => {
  assert.deepEqual(validateRecurrence({ frequency: "weekly" }), { recurrence: { frequency: "WEEKLY", interval: 1 } });
  assert.deepEqual(validateRecurrence(null), { recurrence: null });
  assert.ok(validateRecurrence({ frequency: "YEARLY" }).error);
  assert.ok(validateRecurrence({ frequency: "DAILY", interval: 0 }).error);
  assert.ok(validateRecurrence({ frequency: "DAILY", interval: 13 }).error);
  assert.ok(validateRecurrence("DAILY").error);
});

test("validateParentTask: same project only, one level deep", async () => {
  const fx = await makeProject("parent");
  const parent = await makeTask(fx, { title: "Parent" });
  const child = await makeTask(fx, { title: "Child", parentTaskId: parent._id });

  assert.ok((await validateParentTask({ orgId: fx.orgId, parentTaskId: parent._id.toString(), projectId: fx.projectId.toString() })).parent);
  const wrongProject = await validateParentTask({ orgId: fx.orgId, parentTaskId: parent._id.toString(), projectId: fx.otherProjectId.toString() });
  assert.equal(wrongProject.status, 400);
  const nested = await validateParentTask({ orgId: fx.orgId, parentTaskId: child._id.toString(), projectId: fx.projectId.toString() });
  assert.equal(nested.status, 400);
  assert.match(nested.error, /can't have their own subtasks/);
});

test("setTaskDependencies: rejects self, cross-project, and cycles; accepts a valid chain", async () => {
  const fx = await makeProject("deps");
  const a = await makeTask(fx, { title: "A" });
  const b = await makeTask(fx, { title: "B" });
  const c = await makeTask(fx, { title: "C" });
  const elsewhere = await makeTask({ ...fx, projectId: fx.otherProjectId }, { title: "Other project" });

  assert.equal((await setTaskDependencies({ orgId: fx.orgId, taskId: a._id.toString(), blockedByTaskIds: [a._id.toString()], actorEmail: email("x") })).status, 400);
  assert.equal((await setTaskDependencies({ orgId: fx.orgId, taskId: a._id.toString(), blockedByTaskIds: [elsewhere._id.toString()], actorEmail: email("x") })).status, 400);

  assert.ok((await setTaskDependencies({ orgId: fx.orgId, taskId: a._id.toString(), blockedByTaskIds: [b._id.toString()], actorEmail: email("x") })).task);
  assert.ok((await setTaskDependencies({ orgId: fx.orgId, taskId: b._id.toString(), blockedByTaskIds: [c._id.toString()], actorEmail: email("x") })).task);
  const cycle = await setTaskDependencies({ orgId: fx.orgId, taskId: c._id.toString(), blockedByTaskIds: [a._id.toString()], actorEmail: email("x") });
  assert.equal(cycle.status, 400);
  assert.match(cycle.error, /circular/);

  const relations = await getTaskRelations(await collections.tasks.findOne({ _id: a._id }));
  assert.deepEqual(relations.blockers.map((t) => t.title), ["B"]);
});

test("transitionTask: blocked tasks can't start until blockers are done; parents can't complete with open subtasks", async () => {
  const fx = await makeProject("guards");
  const blocker = await makeTask(fx, { title: "Blocker" });
  const blocked = await makeTask(fx, { title: "Blocked" });
  await setTaskDependencies({ orgId: fx.orgId, taskId: blocked._id.toString(), blockedByTaskIds: [blocker._id.toString()], actorEmail: email("x") });

  const refused = await transitionTask({ orgId: fx.orgId, taskId: blocked._id.toString(), action: "start", membership: OWNER, actorEmail: email("x") });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /blocked by: "Blocker"/);

  await transitionTask({ orgId: fx.orgId, taskId: blocker._id.toString(), action: "start", membership: OWNER, actorEmail: email("x") });
  await transitionTask({ orgId: fx.orgId, taskId: blocker._id.toString(), action: "complete", membership: OWNER, actorEmail: email("x") });
  const started = await transitionTask({ orgId: fx.orgId, taskId: blocked._id.toString(), action: "start", membership: OWNER, actorEmail: email("x") });
  assert.equal(started.task.status, "IN_PROGRESS");

  const parent = await makeTask(fx, { title: "Parent", status: "IN_PROGRESS" });
  const sub = await makeTask(fx, { title: "Sub", parentTaskId: parent._id });
  const parentRefused = await transitionTask({ orgId: fx.orgId, taskId: parent._id.toString(), action: "complete", membership: OWNER, actorEmail: email("x") });
  assert.equal(parentRefused.status, 409);
  await collections.tasks.updateOne({ _id: sub._id }, { $set: { status: "CANCELLED" } });
  const parentDone = await transitionTask({ orgId: fx.orgId, taskId: parent._id.toString(), action: "complete", membership: OWNER, actorEmail: email("x") });
  assert.equal(parentDone.task.status, "DONE");
});

test("a plain task (no new fields) transitions exactly as before and spawns nothing", async () => {
  const fx = await makeProject("plain");
  const t = await makeTask(fx, { title: "Plain", status: "IN_PROGRESS" });
  const result = await transitionTask({ orgId: fx.orgId, taskId: t._id.toString(), action: "complete", membership: OWNER, actorEmail: email("x") });
  assert.equal(result.task.status, "DONE");
  assert.equal(result.nextTask, undefined);
  assert.equal(await collections.tasks.countDocuments({ orgId: fx.orgId }), 1);
});

test("recurring task: completing spawns exactly one next occurrence, even if completed again after a reopen", async () => {
  const fx = await makeProject("recur");
  const base = await makeTask(fx, { title: "Weekly report", status: "IN_PROGRESS", dueDate: "2026-01-31", assigneeEmail: email("assignee") });
  await collections.tasks.updateOne({ _id: base._id }, { $set: recurrenceFieldsFor(base, { frequency: "MONTHLY", interval: 1 }) });

  const first = await transitionTask({ orgId: fx.orgId, taskId: base._id.toString(), action: "complete", membership: OWNER, actorEmail: email("x") });
  assert.equal(first.nextTaskCreated, true);
  assert.equal(first.nextTask.dueDate, "2026-02-28");
  assert.equal(first.nextTask.status, "TODO");
  assert.equal(first.nextTask.assigneeEmail, email("assignee"));
  assert.equal(first.nextTask.recurrenceOccurrence, 1);

  await transitionTask({ orgId: fx.orgId, taskId: base._id.toString(), action: "reopen", membership: OWNER, actorEmail: email("x") });
  const again = await transitionTask({ orgId: fx.orgId, taskId: base._id.toString(), action: "complete", membership: OWNER, actorEmail: email("x") });
  assert.equal(again.nextTaskCreated, false, "the occurrence already exists");
  assert.equal(await collections.tasks.countDocuments({ orgId: fx.orgId, recurrenceOccurrence: 1 }), 1);

  // The spawned occurrence continues the series and keeps the anchor day.
  await transitionTask({ orgId: fx.orgId, taskId: first.nextTask._id.toString(), action: "start", membership: OWNER, actorEmail: email("x") });
  const second = await transitionTask({ orgId: fx.orgId, taskId: first.nextTask._id.toString(), action: "complete", membership: OWNER, actorEmail: email("x") });
  assert.equal(second.nextTask.dueDate, "2026-03-31");
  assert.equal(second.nextTask.recurrenceOccurrence, 2);
});

test("spawnNextOccurrence: concurrent calls for the same completion create only one task", async () => {
  const fx = await makeProject("race");
  const base = await makeTask(fx, { title: "Daily standup", status: "DONE", dueDate: "2026-05-01" });
  const withRecurrence = { ...base, ...recurrenceFieldsFor(base, { frequency: "DAILY", interval: 1 }) };
  await collections.tasks.updateOne({ _id: base._id }, { $set: recurrenceFieldsFor(base, { frequency: "DAILY", interval: 1 }) });

  const results = await Promise.all([1, 2, 3].map(() => spawnNextOccurrence({ task: withRecurrence, actorEmail: email("x") })));
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(await collections.tasks.countDocuments({ orgId: fx.orgId, recurrenceOccurrence: 1 }), 1);
});
