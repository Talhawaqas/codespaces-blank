// test/business-notifications.test.mjs
//
// Business Workspace gap closure, Batch 1 — Business Operations
// notifications (src/lib/business-notify.js over notify/router.js).
// Email always goes to an injected fake sender, never a real provider, and
// the reminder job is scoped to this test's own orgs so it can never touch
// real data in the shared database.
//
// Run with: node --env-file=.env.local --test test/business-notifications.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { listApprovers, notifyTaskAssigned, notifyApprovalNeeded, notifyDecision, runTaskReminders } from "../src/lib/business-notify.js";
import { EVENTS } from "../src/lib/notify/router.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-bizntf-${RUN_ID}-${label}@example.com`;

let collections;
let notifications;
let deliveries;
let prefs;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  notifications = collections.db.collection("notifications");
  deliveries = collections.db.collection("notification_deliveries");
  prefs = collections.db.collection("notification_prefs");
});

after(async () => {
  const { orgs, orgMembers, departments, projects, tasks } = collections;
  const filter = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([notifications.deleteMany(filter), deliveries.deleteMany(filter), prefs.deleteMany(filter),
    orgMembers.deleteMany(filter), departments.deleteMany(filter), projects.deleteMany(filter), tasks.deleteMany(filter)]);
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function fakeSender() {
  const sent = [];
  const fn = async (msg) => { sent.push(msg); return { sent: true }; };
  fn.sent = sent;
  return fn;
}

async function makeOrg(label) {
  const now = new Date().toISOString();
  const org = await collections.orgs.insertOne({ name: `${label} Co`, createdAt: now });
  const orgId = org.insertedId;
  cleanup.orgIds.push(orgId);
  const dept = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const otherDept = await collections.departments.insertOne({ orgId, name: "Sales", createdAt: now });
  const project = await collections.projects.insertOne({ orgId, departmentId: dept.insertedId, name: "P", createdAt: now });
  const member = (role, label2, extra = {}) => ({ orgId, email: email(`${label}-${label2}`), role, status: "active", departmentIds: [], createdAt: now, ...extra });
  await collections.orgMembers.insertMany([
    member("owner", "owner"),
    member("admin", "admin"),
    member("member", "staff", { departmentIds: [dept.insertedId] }),
    member("member", "hrmgr", { hrRole: "manager", departmentIds: [dept.insertedId] }),
    member("member", "hrother", { hrRole: "manager", departmentIds: [otherDept.insertedId] }),
    member("member", "gone", { status: "removed" }),
  ]);
  return { orgId, orgIdStr: orgId.toString(), departmentId: dept.insertedId, projectId: project.insertedId, e: (l) => email(`${label}-${l}`) };
}

test("the new Business Ops events are registered in the notification catalog", () => {
  for (const key of ["task.assigned", "task.due_soon", "task.overdue", "procurement.approval", "procurement.decided", "leave.approval", "leave.decided", "inventory.reorder_drafted"]) {
    assert.ok(EVENTS[key], `${key} registered`);
  }
  assert.equal(EVENTS["procurement.approval"].defaults.email, true, "approvals email by default");
  assert.equal(!!EVENTS["task.assigned"].defaults.email, false, "routine task events don't email by default");
});

test("listApprovers matches the workflows' own approval rules", async () => {
  const fx = await makeOrg("approvers");
  const procurement = await listApprovers({ orgId: fx.orgIdStr, kind: "procurement", excludeEmail: fx.e("admin") });
  assert.deepEqual(procurement.sort(), [fx.e("owner")], "owner/admin only, requester excluded");

  const leave = await listApprovers({ orgId: fx.orgIdStr, kind: "leave", departmentId: fx.departmentId });
  assert.deepEqual(leave.sort(), [fx.e("admin"), fx.e("hrmgr"), fx.e("owner")].sort(), "HR manager of this department plus owner/admin; not the other department's HR manager, not staff, not removed members");
});

test("notifyTaskAssigned: notifies the assignee once, never the person assigning themself", async () => {
  const fx = await makeOrg("assign");
  const task = { _id: randomUUID(), title: "Prepare Q3 board pack", assigneeEmail: fx.e("staff"), dueDate: "2026-11-01" };
  const sender = fakeSender();
  await notifyTaskAssigned({ orgId: fx.orgIdStr, task, actorEmail: fx.e("owner"), assignedAt: "t1", sender });
  await notifyTaskAssigned({ orgId: fx.orgIdStr, task, actorEmail: fx.e("owner"), assignedAt: "t1", sender });
  const rows = await notifications.find({ orgId: fx.orgId, targetEmail: fx.e("staff"), type: "task.assigned" }).toArray();
  assert.equal(rows.length, 1, "deduped");
  assert.match(rows[0].title, /Prepare Q3 board pack/);
  assert.equal(sender.sent.length, 0, "no email by default");

  await notifyTaskAssigned({ orgId: fx.orgIdStr, task: { ...task, assigneeEmail: fx.e("owner") }, actorEmail: fx.e("owner"), assignedAt: "t2", sender });
  assert.equal(await notifications.countDocuments({ orgId: fx.orgId, targetEmail: fx.e("owner"), type: "task.assigned" }), 0);
});

test("notifyApprovalNeeded: in-app with details for approvers, email with only generic text", async () => {
  const fx = await makeOrg("approval");
  const sender = fakeSender();
  const approvers = await notifyApprovalNeeded({
    orgId: fx.orgIdStr, recordType: "PURCHASE_REQUEST", recordId: "pr-1", label: 'Purchase request "Secret laptops"',
    departmentId: fx.departmentId, requesterEmail: fx.e("staff"), sender,
  });
  assert.deepEqual(approvers.sort(), [fx.e("admin"), fx.e("owner")].sort());
  const inApp = await notifications.find({ orgId: fx.orgId, type: "procurement.approval" }).toArray();
  assert.equal(inApp.length, 2);
  assert.ok(inApp.every((n) => /Secret laptops/.test(n.title)));
  assert.equal(sender.sent.length, 2, "one email per approver");
  assert.ok(sender.sent.every((m) => !JSON.stringify(m).includes("Secret laptops")), "protected detail never put in email");

  await notifyDecision({ orgId: fx.orgIdStr, recordType: "PURCHASE_REQUEST", recordId: "pr-1", label: "Purchase request", targetEmail: fx.e("staff"), decision: "APPROVED", actorEmail: fx.e("owner"), sender });
  assert.equal(await notifications.countDocuments({ orgId: fx.orgId, type: "procurement.decided", targetEmail: fx.e("staff") }), 1);
});

test("a notification failure never throws into the business action", async () => {
  const fx = await makeOrg("failure");
  const throwingSender = async () => { throw new Error("email provider down"); };
  await assert.doesNotReject(notifyApprovalNeeded({
    orgId: fx.orgIdStr, recordType: "LEAVE_REQUEST", recordId: "lv-1", label: "Leave", departmentId: fx.departmentId, requesterEmail: fx.e("staff"), sender: throwingSender,
  }));
  assert.ok(await notifications.countDocuments({ orgId: fx.orgId, type: "leave.approval" }) > 0, "in-app still delivered when email fails");
  assert.equal(await notifyTaskAssigned({ orgId: "not-a-valid-id", task: { _id: "x", title: "t", assigneeEmail: "a@example.com" }, actorEmail: "b@example.com" }), null);
});

test("runTaskReminders: due-tomorrow and recently-overdue, once each; skips done, unassigned and long-stale tasks", async () => {
  const fx = await makeOrg("remind");
  const now = Date.UTC(2026, 9, 17, 6, 30);
  const day = (offset) => new Date(now + offset * 86400000).toISOString().slice(0, 10);
  const base = { orgId: fx.orgId, departmentId: fx.departmentId, projectId: fx.projectId, priority: "MEDIUM", createdByEmail: fx.e("owner"), deletedAt: null, createdAt: new Date(now).toISOString() };
  await collections.tasks.insertMany([
    { ...base, title: "Due tomorrow", status: "TODO", assigneeEmail: fx.e("staff"), dueDate: day(1) },
    { ...base, title: "Overdue yesterday", status: "IN_PROGRESS", assigneeEmail: fx.e("staff"), dueDate: `${day(-1)}T17:00:00.000Z` },
    { ...base, title: "Stale", status: "TODO", assigneeEmail: fx.e("staff"), dueDate: day(-30) },
    { ...base, title: "Done", status: "DONE", assigneeEmail: fx.e("staff"), dueDate: day(1) },
    { ...base, title: "Unassigned", status: "TODO", assigneeEmail: null, dueDate: day(1) },
    { ...base, title: "Next week", status: "TODO", assigneeEmail: fx.e("staff"), dueDate: day(7) },
  ]);

  const first = await runTaskReminders({ now, orgIds: [fx.orgIdStr], sender: fakeSender() });
  assert.equal(first.dueSoon, 1);
  assert.equal(first.overdue, 1);
  const second = await runTaskReminders({ now, orgIds: [fx.orgIdStr], sender: fakeSender() });
  assert.equal(second.dueSoon + second.overdue, 0, "already-sent reminders are not repeated");

  // A person who turned email on for reminders still gets just one email.
  await prefs.updateOne({ orgId: fx.orgId, email: fx.e("staff") }, { $set: { "events.task~due_soon.email": true } }, { upsert: true });
  const sender = fakeSender();
  await runTaskReminders({ now, orgIds: [fx.orgIdStr], sender });
  assert.equal(sender.sent.length, 0, "the earlier delivery record suppresses a repeat");
});
