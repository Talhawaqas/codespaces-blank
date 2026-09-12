// test/insights-date-range.test.mjs
//
// Business Workspace Remaining Features SOW — Custom Date-Range Picker.
// computeBusinessInsights() accepts an explicit startDate/endDate that
// overrides periodDays entirely. Two checks: (1) an explicit range
// produces exactly the window asked for (not "now"-anchored), and (2)
// omitting the range keeps the existing preset behavior byte-identical.
//
// Run with: node --env-file=.env.local --test test/insights-date-range.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { computeBusinessInsights } from "../src/lib/business-insights.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-insights-range-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, invoices } = collections;
  await Promise.all([
    orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    departments.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    invoices.deleteMany({ orgId: { $in: cleanup.orgIds } }),
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

test("insights: an explicit date range sums only invoices paid inside that window, not the preset window", async () => {
  const org = await makeOrg("range-basic");
  const base = { orgId: org.orgId, departmentId: org.departmentId, contactId: org.orgId, invoiceNumber: "INV-1", issueDate: daysAgo(60), dueDate: daysAgo(60), lineItems: [], subtotal: 0, currency: "USD", status: "PAID", createdByEmail: org.ownerEmail, createdAt: daysAgo(60), deletedAt: null };
  await collections.invoices.insertMany([
    { ...base, total: 100, updatedAt: daysAgo(55) }, // inside the 50-70-days-ago custom range
    { ...base, total: 900, updatedAt: daysAgo(5) },  // inside the default 30-day preset, but outside the custom range
  ]);

  const startDate = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endDate = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ranged = await computeBusinessInsights({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, startDate, endDate });
  assert.equal(ranged.comparison.revenue.current, 100, "only the invoice paid inside the explicit 50-70-days-ago window should count");

  const preset = await computeBusinessInsights({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, periodDays: 30 });
  assert.equal(preset.comparison.revenue.current, 900, "omitting the range keeps the existing 30-day preset behavior unaffected");
});

test("VALIDATION: rejects an end date before the start date", async () => {
  const org = await makeOrg("range-invalid");
  await assert.rejects(
    computeBusinessInsights({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail, startDate: "2026-02-01", endDate: "2026-01-01" }),
    /Invalid date range/
  );
});
