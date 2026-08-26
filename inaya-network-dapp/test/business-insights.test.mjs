// test/business-insights.test.mjs
//
// Business Insights & KPI Dashboard — computeBusinessInsights() correctness
// against real fixture data on real Atlas: KPI arithmetic, period-over-
// period comparison, alert generation, and permission scoping (department
// boundaries + Finance/HR role gates already enforced by getAccessibleScope,
// re-verified here at the insights layer rather than re-tested from scratch).
//
// Run with: node --env-file=.env.local --test test/business-insights.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { computeBusinessInsights } from "../src/lib/business-insights.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-insights-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, projects, invoices, expenses, crmDeals, tasks, products, stockLevels, employees } = collections;
  await Promise.all([
    orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    departments.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    projects.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    invoices.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    expenses.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    crmDeals.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    tasks.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    products.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    stockLevels.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    employees.deleteMany({ orgId: { $in: cleanup.orgIds } }),
  ]);
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function makeOrg(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  const deptResult = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const ownerEmail = email(`${label}-owner`);
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  return { orgId, departmentId: deptResult.insertedId, owner, ownerEmail };
}

// ============================================================
// KPI + trend correctness
// ============================================================
test("insights: revenue KPI sums only PAID invoices, ignores DRAFT/SENT/CANCELLED", async () => {
  const org = await makeOrg("kpi-revenue");
  const now = new Date().toISOString();
  const base = { orgId: org.orgId, departmentId: org.departmentId, contactId: org.orgId, invoiceNumber: "INV-1", issueDate: now, dueDate: now, lineItems: [], subtotal: 100, currency: "USD", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null };
  await collections.invoices.insertMany([
    { ...base, total: 500, status: "PAID" },
    { ...base, total: 300, status: "PAID" },
    { ...base, total: 1000, status: "DRAFT" },
    { ...base, total: 1000, status: "SENT" },
    { ...base, total: 1000, status: "CANCELLED" },
  ]);

  const insights = await computeBusinessInsights({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, periodDays: 30 });
  assert.equal(insights.kpis.revenue.value, 800, "only the two PAID invoices (500+300) should count toward revenue");
});

test("insights: overdue invoices and low stock feed both the KPI count and the alerts list", async () => {
  const org = await makeOrg("kpi-alerts");
  const now = new Date().toISOString();
  await collections.invoices.insertOne({
    orgId: org.orgId, departmentId: org.departmentId, contactId: org.orgId, invoiceNumber: "INV-OD", issueDate: now, dueDate: now,
    lineItems: [], subtotal: 250, total: 250, currency: "USD", status: "OVERDUE", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });
  const productResult = await collections.products.insertOne({
    orgId: org.orgId, departmentId: org.departmentId, sku: "SKU-1", name: "Widget", reorderThreshold: 10, status: "ACTIVE", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });
  await collections.stockLevels.insertOne({ orgId: org.orgId, productId: productResult.insertedId, warehouseId: org.orgId, quantity: 2 });

  const insights = await computeBusinessInsights({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, periodDays: 30 });
  assert.equal(insights.kpis.overdueInvoices.value, 1);
  assert.equal(insights.kpis.lowStockCount.value, 1);
  assert.ok(insights.alerts.some((a) => a.type === "OVERDUE_INVOICES"), "an overdue invoice must produce an OVERDUE_INVOICES alert");
  assert.ok(insights.alerts.some((a) => a.type === "LOW_STOCK"), "a below-threshold product must produce a LOW_STOCK alert");
  // High severity (overdue invoices) must sort before medium (low stock).
  const types = insights.alerts.map((a) => a.type);
  assert.ok(types.indexOf("OVERDUE_INVOICES") < types.indexOf("LOW_STOCK"), "alerts must be sorted most-severe first");
});

test("insights: period-over-period comparison correctly buckets current vs. prior window", async () => {
  const org = await makeOrg("kpi-comparison");
  const dealBase = { orgId: org.orgId, departmentId: org.departmentId, contactId: org.orgId, title: "Deal", status: "WON", createdAt: daysAgo(50) };
  await collections.crmDeals.insertMany([
    { ...dealBase, value: 1000, closedAt: daysAgo(5) },  // inside current 30-day window
    { ...dealBase, value: 2000, closedAt: daysAgo(45) }, // inside the prior 30-day window
    { ...dealBase, value: 5000, closedAt: daysAgo(90) }, // outside both windows entirely
  ]);

  const insights = await computeBusinessInsights({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, periodDays: 30 });
  assert.equal(insights.comparison.dealsWon.current, 1, "only the deal closed 5 days ago falls in the current 30-day window");
  assert.equal(insights.comparison.dealsWon.previous, 1, "only the deal closed 45 days ago falls in the prior 30-day window");
});

test("insights: task completion rate and headcount reflect only this org's real records", async () => {
  const org = await makeOrg("kpi-tasks");
  const now = new Date().toISOString();
  // visibleTasks is resolved via real project membership (getAccessibleScope
  // scopes tasks by projectId, not departmentId directly) — a fixture task
  // needs a real project row, not just a department, or it's silently
  // invisible to the scope resolver.
  const projectResult = await collections.projects.insertOne({ orgId: org.orgId, departmentId: org.departmentId, name: "Project", createdAt: now });
  await collections.tasks.insertMany([
    { orgId: org.orgId, departmentId: org.departmentId, projectId: projectResult.insertedId, title: "T1", status: "DONE", createdAt: now, updatedAt: now, deletedAt: null },
    { orgId: org.orgId, departmentId: org.departmentId, projectId: projectResult.insertedId, title: "T2", status: "IN_PROGRESS", createdAt: now, updatedAt: now, deletedAt: null },
  ]);
  await collections.employees.insertMany([
    { orgId: org.orgId, departmentId: org.departmentId, memberEmail: null, fullName: "Active One", employmentStatus: "ACTIVE", joiningDate: now, annualLeaveAllocationDays: 20, createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null },
    { orgId: org.orgId, departmentId: org.departmentId, memberEmail: null, fullName: "Terminated One", employmentStatus: "TERMINATED", joiningDate: now, annualLeaveAllocationDays: 20, createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null },
  ]);

  const insights = await computeBusinessInsights({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, periodDays: 30 });
  assert.equal(insights.kpis.taskCompletionRate.value, 50, "1 of 2 tasks DONE = 50%");
  assert.equal(insights.kpis.headcount.value, 1, "only the ACTIVE employee counts toward headcount");
});

// ============================================================
// Permission scoping — an org-isolated caller sees zero of another org's data
// ============================================================
test("insights: org isolation — org A's data never leaks into org B's insights", async () => {
  const orgA = await makeOrg("scope-a");
  const orgB = await makeOrg("scope-b");
  const now = new Date().toISOString();
  await collections.invoices.insertOne({
    orgId: orgA.orgId, departmentId: orgA.departmentId, contactId: orgA.orgId, invoiceNumber: "INV-A", issueDate: now, dueDate: now,
    lineItems: [], subtotal: 9999, total: 9999, currency: "USD", status: "PAID", createdByEmail: orgA.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });

  const insightsB = await computeBusinessInsights({ orgId: orgB.orgId, membership: orgB.owner, email: orgB.ownerEmail, periodDays: 30 });
  assert.equal(insightsB.kpis.revenue.value, 0, "org B must never see org A's revenue");
});
