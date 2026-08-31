// test/permission-boundaries.test.mjs
//
// Business Workspace Phase 1 — cross-module permission regression test.
// Every individual module (Tasks/CRM/Procurement/Inventory/Finance/HR)
// already has its own workflow test; this is the one that wasn't
// explicitly covered anywhere: getAccessibleScope() resolving correctly
// when a single org has members with DIFFERENT, overlapping permission
// axes (org role, financeRole, hrRole, departmentIds, managedDepartmentIds)
// all active at once. Exercises exactly the three scenarios named in the
// SOW: a Finance Staff member with no HR role can't see employees; a
// Department Manager sees only their department's employees but full
// access to their own department's tasks/CRM/inventory; an org owner sees
// everything. Same node --test + real Atlas + RUN_ID-fixtures convention
// as every other test file in this repo.
//
// Run with: node --env-file=.env.local --test test/permission-boundaries.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { getAccessibleScope } from "../src/lib/document-permissions.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-permb-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = {
  orgIds: [], departmentIds: [], taskIds: [], contactIds: [], productIds: [],
  invoiceIds: [], expenseIds: [], employeeIds: [], projectIds: [],
};

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const {
    orgs, orgMembers, departments, projects, tasks, crmContacts, products,
    invoices, expenses, employees,
  } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await tasks.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await crmContacts.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await products.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await invoices.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await expenses.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await employees.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

// One org, two departments, four members with distinct/overlapping
// permission axes — the exact shape the SOW asks this test to cover.
async function makeFixture() {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `PermBoundary Co`, ownerEmail: email("owner"), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptAResult = await collections.departments.insertOne({ orgId, name: "Engineering", createdAt: now });
  const deptBResult = await collections.departments.insertOne({ orgId, name: "Sales", createdAt: now });
  const deptAId = deptAResult.insertedId;
  const deptBId = deptBResult.insertedId;

  const ownerEmail = email("owner");
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });

  // Finance Staff — canAccessFinance, but explicitly NO hrRole. Scoped to
  // deptA only.
  const financeStaffEmail = email("financestaff");
  await collections.orgMembers.insertOne({ orgId, email: financeStaffEmail, role: "member", departmentIds: [deptAId], financeRole: "staff", status: "active", invitedAt: now, joinedAt: now });

  // Department Manager for deptA only — a plain member of deptA (so they
  // get ordinary department-scoped access to Tasks/CRM/Inventory there)
  // PLUS managedDepartmentIds:[deptA] (so they additionally get employee
  // read access for deptA specifically) — no hrRole, no finance role.
  const deptMgrEmail = email("deptmgr");
  await collections.orgMembers.insertOne({ orgId, email: deptMgrEmail, role: "member", departmentIds: [deptAId], managedDepartmentIds: [deptAId], status: "active", invitedAt: now, joinedAt: now });

  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const financeStaff = await collections.orgMembers.findOne({ orgId, email: financeStaffEmail });
  const deptMgr = await collections.orgMembers.findOne({ orgId, email: deptMgrEmail });

  // One project per department (tasks are project-scoped, not directly
  // department-scoped) and fixture records across both departments in
  // every department-scoped module the SOW names.
  const projA = await collections.projects.insertOne({ orgId, departmentId: deptAId, name: "Proj A", createdAt: now });
  const projB = await collections.projects.insertOne({ orgId, departmentId: deptBId, name: "Proj B", createdAt: now });
  cleanup.projectIds.push(projA.insertedId, projB.insertedId);

  const taskA = await collections.tasks.insertOne({ orgId, projectId: projA.insertedId, title: "Task A", status: "TODO", priority: "MEDIUM", deletedAt: null, createdAt: now });
  const taskB = await collections.tasks.insertOne({ orgId, projectId: projB.insertedId, title: "Task B", status: "TODO", priority: "MEDIUM", deletedAt: null, createdAt: now });
  cleanup.taskIds.push(taskA.insertedId, taskB.insertedId);

  const contactA = await collections.crmContacts.insertOne({ orgId, departmentId: deptAId, type: "LEAD", name: "Contact A", deletedAt: null, createdAt: now });
  const contactB = await collections.crmContacts.insertOne({ orgId, departmentId: deptBId, type: "LEAD", name: "Contact B", deletedAt: null, createdAt: now });
  cleanup.contactIds.push(contactA.insertedId, contactB.insertedId);

  const productA = await collections.products.insertOne({ orgId, departmentId: deptAId, sku: "A-1", name: "Product A", deletedAt: null, createdAt: now });
  const productB = await collections.products.insertOne({ orgId, departmentId: deptBId, sku: "B-1", name: "Product B", deletedAt: null, createdAt: now });
  cleanup.productIds.push(productA.insertedId, productB.insertedId);

  const invoiceA = await collections.invoices.insertOne({ orgId, departmentId: deptAId, invoiceNumber: "INV-A", status: "DRAFT", total: 100, deletedAt: null, createdAt: now });
  cleanup.invoiceIds.push(invoiceA.insertedId);
  const expenseA = await collections.expenses.insertOne({ orgId, departmentId: deptAId, vendor: "Vendor A", category: "Ops", amount: 50, status: "DRAFT", deletedAt: null, createdAt: now });
  cleanup.expenseIds.push(expenseA.insertedId);

  const employeeA = await collections.employees.insertOne({ orgId, departmentId: deptAId, memberEmail: null, fullName: "Employee A", employmentStatus: "ACTIVE", joiningDate: now, deletedAt: null, createdAt: now });
  const employeeB = await collections.employees.insertOne({ orgId, departmentId: deptBId, memberEmail: null, fullName: "Employee B", employmentStatus: "ACTIVE", joiningDate: now, deletedAt: null, createdAt: now });
  cleanup.employeeIds.push(employeeA.insertedId, employeeB.insertedId);

  return {
    orgId, deptAId, deptBId,
    ownerEmail, owner, financeStaffEmail, financeStaff, deptMgrEmail, deptMgr,
    taskAId: taskA.insertedId, taskBId: taskB.insertedId,
    contactAId: contactA.insertedId, contactBId: contactB.insertedId,
    productAId: productA.insertedId, productBId: productB.insertedId,
    invoiceAId: invoiceA.insertedId, expenseAId: expenseA.insertedId,
    employeeAId: employeeA.insertedId, employeeBId: employeeB.insertedId,
  };
}

test("Finance Staff with no HR role: sees finance/dept-scoped records in their department, but zero employee visibility", async () => {
  const fx = await makeFixture();
  const scope = await getAccessibleScope({ orgId: fx.orgId, membership: fx.financeStaff, email: fx.financeStaffEmail });

  // Ordinary department-scoped visibility (Tasks/CRM/Inventory) still
  // applies — financeRole is additive, not a narrower substitute for
  // department membership.
  assert.equal(scope.visibleTasks.some((t) => t._id.equals(fx.taskAId)), true);
  assert.equal(scope.visibleTasks.some((t) => t._id.equals(fx.taskBId)), false);
  assert.equal(scope.visibleContacts.some((c) => c._id.equals(fx.contactAId)), true);
  assert.equal(scope.visibleContacts.some((c) => c._id.equals(fx.contactBId)), false);

  // Finance visibility, gated by canAccessFinance, within their department.
  assert.equal(scope.visibleInvoices.some((i) => i._id.equals(fx.invoiceAId)), true);
  assert.equal(scope.visibleExpenses.some((e) => e._id.equals(fx.expenseAId)), true);

  // No hrRole and not a Department Manager -> zero employee visibility,
  // even for the department they otherwise fully see.
  assert.equal(scope.visibleEmployees.length, 0);
});

test("Department Manager (deptA): sees deptA employees only, plus full deptA task/CRM/inventory access", async () => {
  const fx = await makeFixture();
  const scope = await getAccessibleScope({ orgId: fx.orgId, membership: fx.deptMgr, email: fx.deptMgrEmail });

  assert.equal(scope.visibleEmployees.some((e) => e._id.equals(fx.employeeAId)), true);
  assert.equal(scope.visibleEmployees.some((e) => e._id.equals(fx.employeeBId)), false);

  assert.equal(scope.visibleTasks.some((t) => t._id.equals(fx.taskAId)), true);
  assert.equal(scope.visibleTasks.some((t) => t._id.equals(fx.taskBId)), false);
  assert.equal(scope.visibleContacts.some((c) => c._id.equals(fx.contactAId)), true);
  assert.equal(scope.visibleProducts.some((p) => p._id.equals(fx.productAId)), true);

  // No finance role at all -> zero finance visibility even within their
  // own accessible department.
  assert.equal(scope.visibleInvoices.length, 0);
  assert.equal(scope.visibleExpenses.length, 0);
});

test("Org owner: sees every record in every department across every module", async () => {
  const fx = await makeFixture();
  const scope = await getAccessibleScope({ orgId: fx.orgId, membership: fx.owner, email: fx.ownerEmail });

  assert.equal(scope.visibleTasks.some((t) => t._id.equals(fx.taskAId)), true);
  assert.equal(scope.visibleTasks.some((t) => t._id.equals(fx.taskBId)), true);
  assert.equal(scope.visibleContacts.some((c) => c._id.equals(fx.contactAId)), true);
  assert.equal(scope.visibleContacts.some((c) => c._id.equals(fx.contactBId)), true);
  assert.equal(scope.visibleProducts.some((p) => p._id.equals(fx.productAId)), true);
  assert.equal(scope.visibleProducts.some((p) => p._id.equals(fx.productBId)), true);
  assert.equal(scope.visibleInvoices.some((i) => i._id.equals(fx.invoiceAId)), true);
  assert.equal(scope.visibleExpenses.some((e) => e._id.equals(fx.expenseAId)), true);
  assert.equal(scope.visibleEmployees.some((e) => e._id.equals(fx.employeeAId)), true);
  assert.equal(scope.visibleEmployees.some((e) => e._id.equals(fx.employeeBId)), true);
});
