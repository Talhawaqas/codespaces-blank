// test/record-grants.test.mjs
//
// Business Workspace gap closure, Batch 2 — private tasks and deals
// (src/lib/record-grants.js), including the getAccessibleScope filter and
// the task transition guard. DEPARTMENT records must behave exactly as
// before.
//
// Run with: node --env-file=.env.local --test test/record-grants.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { filterVisibleRecords, canAccessRecord, grantAccess, revokeAccess, setVisibility, canManageRecordSharing } from "../src/lib/record-grants.js";
import { getAccessibleScope } from "../src/lib/document-permissions.js";
import { transitionTask } from "../src/lib/task-workflow.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (l) => `test-grants-${RUN_ID}-${l}@example.com`;
let c;
const cleanup = { orgIds: [] };

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  const f = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([c.orgMembers, c.departments, c.projects, c.tasks, c.crmDeals, c.crmContacts, c.recordGrants, c.orgActivity, c.auditChainEntries, c.auditChainHeads].map((x) => x.deleteMany(f)));
  await c.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await (await mongoClientPromise).close();
});

async function fixture() {
  const now = new Date().toISOString();
  const org = await c.orgs.insertOne({ name: `grants-${RUN_ID}`, createdAt: now });
  const orgId = org.insertedId;
  cleanup.orgIds.push(orgId);
  const dept = (await c.departments.insertOne({ orgId, name: "Sales", createdAt: now })).insertedId;
  const project = (await c.projects.insertOne({ orgId, departmentId: dept, name: "P", createdAt: now })).insertedId;
  const m = {};
  for (const [k, role] of [["owner", "owner"], ["creator", "member"], ["assignee", "member"], ["grantee", "member"], ["outsider", "member"]]) {
    m[k] = { orgId, email: email(k), role, status: "active", departmentIds: [dept] };
  }
  await c.orgMembers.insertMany(Object.values(m).map((x) => ({ ...x })));
  const task = (extra) => c.tasks.insertOne({ orgId, departmentId: dept, projectId: project, title: "T", status: "TODO", priority: "MEDIUM", createdByEmail: email("creator"), assigneeEmail: email("assignee"), deletedAt: null, createdAt: now, updatedAt: now, ...extra });
  const priv = await task({ title: "Private plan", visibility: "PRIVATE" });
  const open = await task({ title: "Open task" });
  const contact = (await c.crmContacts.insertOne({ orgId, departmentId: dept, name: "C", type: "LEAD", deletedAt: null })).insertedId;
  const deal = await c.crmDeals.insertOne({ orgId, departmentId: dept, contactId: contact, title: "Private deal", value: 5000, status: "NEW", visibility: "PRIVATE", createdByEmail: email("creator"), deletedAt: null, createdAt: now });
  const get = async (col, id) => col.findOne({ _id: id });
  return { orgId: orgId.toString(), m, privTask: await get(c.tasks, priv.insertedId), openTask: await get(c.tasks, open.insertedId), deal: await get(c.crmDeals, deal.insertedId) };
}

test("private task: visible to owner, creator, assignee and grantees only", async () => {
  const fx = await fixture();
  const sees = async (who) => canAccessRecord({ orgId: fx.orgId, recordType: "TASK", record: fx.privTask, membership: fx.m[who], email: fx.m[who].email });
  assert.equal(await sees("owner"), true);
  assert.equal(await sees("creator"), true);
  assert.equal(await sees("assignee"), true);
  assert.equal(await sees("grantee"), false);
  assert.equal(await sees("outsider"), false);

  await grantAccess({ orgId: fx.orgId, recordType: "TASK", record: fx.privTask, email: fx.m.grantee.email, level: "VIEW", actorEmail: fx.m.creator.email });
  assert.equal(await sees("grantee"), true);
  assert.equal(await canAccessRecord({ orgId: fx.orgId, recordType: "TASK", record: fx.privTask, membership: fx.m.grantee, email: fx.m.grantee.email, need: "EDIT" }), false, "VIEW grant can't edit");
  await revokeAccess({ orgId: fx.orgId, recordType: "TASK", record: fx.privTask, email: fx.m.grantee.email, actorEmail: fx.m.creator.email });
  assert.equal(await sees("grantee"), false);
});

test("expired grants stop working; only active members can be granted", async () => {
  const fx = await fixture();
  await grantAccess({ orgId: fx.orgId, recordType: "DEAL", record: fx.deal, email: fx.m.grantee.email, level: "EDIT", expiresAt: "2020-01-01T00:00:00Z", actorEmail: fx.m.creator.email });
  assert.equal(await canAccessRecord({ orgId: fx.orgId, recordType: "DEAL", record: fx.deal, membership: fx.m.grantee, email: fx.m.grantee.email }), false);
  assert.equal((await grantAccess({ orgId: fx.orgId, recordType: "DEAL", record: fx.deal, email: "stranger@example.com", actorEmail: fx.m.creator.email })).status, 400);
  assert.equal(canManageRecordSharing(fx.deal, fx.m.outsider, fx.m.outsider.email), false);
  assert.equal(canManageRecordSharing(fx.deal, fx.m.creator, fx.m.creator.email), true);
});

test("getAccessibleScope hides private tasks and deals from outsiders but leaves DEPARTMENT records alone", async () => {
  const fx = await fixture();
  const scopeFor = (who) => getAccessibleScope({ orgId: fx.orgId, membership: fx.m[who], email: fx.m[who].email });
  const outsider = await scopeFor("outsider");
  assert.deepEqual(outsider.visibleTasks.map((t) => t.title), ["Open task"]);
  assert.equal(outsider.visibleDeals.length, 0);
  const assignee = await scopeFor("assignee");
  assert.deepEqual(assignee.visibleTasks.map((t) => t.title).sort(), ["Open task", "Private plan"]);
  const owner = await scopeFor("owner");
  assert.equal(owner.visibleDeals.length, 1);

  await setVisibility({ orgId: fx.orgId, recordType: "TASK", record: fx.privTask, visibility: "DEPARTMENT", actorEmail: fx.m.creator.email });
  assert.equal((await scopeFor("outsider")).visibleTasks.length, 2, "switching back restores department visibility");
});

test("transitionTask refuses people who can't see a private task", async () => {
  const fx = await fixture();
  const refused = await transitionTask({ orgId: fx.orgId, taskId: fx.privTask._id.toString(), action: "start", membership: fx.m.outsider, actorEmail: fx.m.outsider.email });
  assert.equal(refused.status, 404);
  const ok = await transitionTask({ orgId: fx.orgId, taskId: fx.privTask._id.toString(), action: "start", membership: fx.m.assignee, actorEmail: fx.m.assignee.email });
  assert.equal(ok.task.status, "IN_PROGRESS");
  const openOk = await transitionTask({ orgId: fx.orgId, taskId: fx.openTask._id.toString(), action: "start", membership: fx.m.outsider, actorEmail: fx.m.outsider.email });
  assert.equal(openOk.task.status, "IN_PROGRESS", "department tasks unchanged");
});

test("filterVisibleRecords: bulk filter costs nothing when no record is private", async () => {
  const fx = await fixture();
  const out = await filterVisibleRecords({ orgId: fx.orgId, recordType: "TASK", records: [fx.openTask], membership: fx.m.outsider, email: fx.m.outsider.email });
  assert.equal(out.length, 1);
});
