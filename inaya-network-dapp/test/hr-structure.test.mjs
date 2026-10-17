// test/hr-structure.test.mjs
//
// Business Workspace gap closure, Batch 1 — reporting lines, org chart and
// the onboarding checklist (src/lib/hr-structure.js).
//
// Run with: node --env-file=.env.local --test test/hr-structure.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  setEmployeeManager, buildOrgChart, ensureOnboardingChecklist, listOnboardingItems,
  setOnboardingItemDone, addOnboardingItem, setOnboardingTemplate, getOnboardingTemplate, DEFAULT_ONBOARDING_ITEMS,
} from "../src/lib/hr-structure.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-hrstruct-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, departments, employees, hrOnboardingTemplates, hrOnboardingItems, orgActivity, auditChainEntries, auditChainHeads } = collections;
  const filter = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([departments, employees, hrOnboardingTemplates, hrOnboardingItems, orgActivity, auditChainEntries, auditChainHeads].map((c) => c.deleteMany(filter)));
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const org = await collections.orgs.insertOne({ name: `${label} Co`, createdAt: now });
  cleanup.orgIds.push(org.insertedId);
  const dept = await collections.departments.insertOne({ orgId: org.insertedId, name: "Ops", createdAt: now });
  return { orgId: org.insertedId, orgIdStr: org.insertedId.toString(), departmentId: dept.insertedId };
}

async function makeEmployee(fx, fullName, extra = {}) {
  const now = new Date().toISOString();
  const r = await collections.employees.insertOne({ orgId: fx.orgId, departmentId: fx.departmentId, fullName, jobTitle: null, employmentStatus: "ACTIVE", createdAt: now, updatedAt: now, deletedAt: null, ...extra });
  return { _id: r.insertedId, orgId: fx.orgId, departmentId: fx.departmentId, fullName, employmentStatus: "ACTIVE", ...extra };
}

test("setEmployeeManager: sets a manager; rejects self-management and cycles", async () => {
  const fx = await makeOrg("mgr");
  const ceo = await makeEmployee(fx, "Ceo");
  const lead = await makeEmployee(fx, "Lead");
  const dev = await makeEmployee(fx, "Dev");

  assert.ok((await setEmployeeManager({ orgId: fx.orgIdStr, employeeId: lead._id.toString(), managerEmployeeId: ceo._id.toString(), actorEmail: email("hr") })).employee);
  assert.ok((await setEmployeeManager({ orgId: fx.orgIdStr, employeeId: dev._id.toString(), managerEmployeeId: lead._id.toString(), actorEmail: email("hr") })).employee);
  assert.equal((await setEmployeeManager({ orgId: fx.orgIdStr, employeeId: dev._id.toString(), managerEmployeeId: dev._id.toString(), actorEmail: email("hr") })).status, 400);
  const cycle = await setEmployeeManager({ orgId: fx.orgIdStr, employeeId: ceo._id.toString(), managerEmployeeId: dev._id.toString(), actorEmail: email("hr") });
  assert.equal(cycle.status, 400);
  assert.match(cycle.error, /circular/);

  const cleared = await setEmployeeManager({ orgId: fx.orgIdStr, employeeId: dev._id.toString(), managerEmployeeId: null, actorEmail: email("hr") });
  assert.equal(cleared.employee.managerEmployeeId, null);
});

test("buildOrgChart: nests reports; anyone whose manager isn't visible is a root", async () => {
  const fx = await makeOrg("chart");
  const ceo = await makeEmployee(fx, "Ceo");
  const lead = await makeEmployee(fx, "Lead", { managerEmployeeId: ceo._id });
  await makeEmployee(fx, "Bea", { managerEmployeeId: lead._id });
  await makeEmployee(fx, "Al", { managerEmployeeId: lead._id });
  const all = await collections.employees.find({ orgId: fx.orgId }).toArray();

  const roots = buildOrgChart(all);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].fullName, "Ceo");
  assert.deepEqual(roots[0].reports[0].reports.map((n) => n.fullName), ["Al", "Bea"], "sorted by name");

  const withoutCeo = all.filter((e) => e.fullName !== "Ceo");
  assert.deepEqual(buildOrgChart(withoutCeo).map((n) => n.fullName), ["Lead"], "manager not visible -> root");

  // A legacy cycle (written before validation existed) still appears, not silently dropped.
  const a = { _id: "a", fullName: "A", departmentId: "d", employmentStatus: "ACTIVE", managerEmployeeId: "b" };
  const b = { _id: "b", fullName: "B", departmentId: "d", employmentStatus: "ACTIVE", managerEmployeeId: "a" };
  assert.equal(buildOrgChart([a, b]).length, 2);
});

test("onboarding checklist: created once from the default template, only while ONBOARDING", async () => {
  const fx = await makeOrg("onboard");
  const hire = await makeEmployee(fx, "New Hire", { employmentStatus: "ONBOARDING" });
  const active = await makeEmployee(fx, "Veteran");

  const results = await Promise.all([1, 2, 3].map(() => ensureOnboardingChecklist({ orgId: fx.orgIdStr, employee: hire, actorEmail: email("hr") })));
  assert.equal(results.filter((r) => r.created).length, 1, "concurrent calls create it exactly once");
  const items = await listOnboardingItems(fx.orgIdStr, hire._id.toString());
  assert.deepEqual(items.map((i) => i.title), DEFAULT_ONBOARDING_ITEMS);

  assert.equal((await ensureOnboardingChecklist({ orgId: fx.orgIdStr, employee: active, actorEmail: email("hr") })).created, false);
  assert.equal((await listOnboardingItems(fx.orgIdStr, active._id.toString())).length, 0);
});

test("onboarding checklist: a custom template applies to later hires; items can be ticked and added", async () => {
  const fx = await makeOrg("template");
  assert.equal((await getOnboardingTemplate(fx.orgIdStr)).isDefault, true);
  assert.equal((await setOnboardingTemplate({ orgId: fx.orgIdStr, items: [], actorEmail: email("hr") })).status, 400);
  await setOnboardingTemplate({ orgId: fx.orgIdStr, items: ["Laptop", "  Badge  ", ""], actorEmail: email("hr") });
  assert.deepEqual((await getOnboardingTemplate(fx.orgIdStr)).items, ["Laptop", "Badge"]);

  const hire = await makeEmployee(fx, "Hire", { employmentStatus: "ONBOARDING" });
  await ensureOnboardingChecklist({ orgId: fx.orgIdStr, employee: hire, actorEmail: email("hr") });
  let items = await listOnboardingItems(fx.orgIdStr, hire._id.toString());
  assert.deepEqual(items.map((i) => i.title), ["Laptop", "Badge"]);

  ({ items } = await setOnboardingItemDone({ orgId: fx.orgIdStr, employeeId: hire._id.toString(), itemId: items[0].id, done: true, actorEmail: email("hr") }));
  assert.equal(items[0].done, true);
  assert.equal(items[0].doneByEmail, email("hr"));
  ({ items } = await addOnboardingItem({ orgId: fx.orgIdStr, employeeId: hire._id.toString(), title: "Parking pass", actorEmail: email("hr") }));
  assert.deepEqual(items.map((i) => i.title), ["Laptop", "Badge", "Parking pass"]);

  const other = await makeEmployee(fx, "Other", { employmentStatus: "ONBOARDING" });
  const crossEmployee = await setOnboardingItemDone({ orgId: fx.orgIdStr, employeeId: other._id.toString(), itemId: items[1].id, done: true, actorEmail: email("hr") });
  assert.equal(crossEmployee.status, 404, "an item can only be ticked on its own employee's checklist");

  const employee = await collections.employees.findOne({ _id: hire._id });
  assert.equal(employee.employmentStatus, "ONBOARDING", "completing items never changes status on its own");
});
