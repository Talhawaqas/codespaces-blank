// test/executive-dashboards.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§113-114) —
// Executive Risk Dashboard and Executive Compliance Dashboard. Both are
// pure read-aggregations; these tests confirm real data flows through
// correctly and free-form risk categories are bucketed honestly (never
// guessed into the wrong SOW-named bucket).
//
// Run with: node --env-file=.env.local --test test/executive-dashboards.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createRisk } from "../src/lib/risk-register.js";
import { createControl, updateControl } from "../src/lib/compliance-controls.js";
import { createVendor } from "../src/lib/vendor-management.js";
import { getExecutiveRiskDashboard } from "../src/lib/executive-risk-dashboard.js";
import { getExecutiveComplianceDashboard } from "../src/lib/executive-compliance-dashboard.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `exec-dash-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Exec Dashboards Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = orgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.riskRegister.deleteMany({ orgId }),
    collections.complianceControls.deleteMany({ orgId }),
    collections.vendorRecords.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("getExecutiveRiskDashboard buckets a known category correctly and an unrecognized one into 'other', never dropped or guessed", async () => {
  await createRisk({ orgId, category: "cyber", severity: "critical", likelihood: "possible", impact: "test", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await createRisk({ orgId, category: "some-made-up-category", severity: "medium", likelihood: "possible", impact: "test", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const dashboard = await getExecutiveRiskDashboard(orgId);
  assert.equal(dashboard.topRisks.cyber.length, 1);
  assert.equal(dashboard.topRisks.cyber[0].severity, "critical");
  assert.equal(dashboard.topRisks.other.length, 1, "an unrecognized category must land in 'other', not be silently dropped");
  assert.equal(dashboard.totalOpenRisks, 2);
});

test("getExecutiveRiskDashboard sorts by severity, most critical first, within each bucket", async () => {
  await createRisk({ orgId, category: "operational", severity: "low", likelihood: "possible", impact: "t", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await createRisk({ orgId, category: "operational", severity: "critical", likelihood: "possible", impact: "t", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await createRisk({ orgId, category: "operational", severity: "medium", likelihood: "possible", impact: "t", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const dashboard = await getExecutiveRiskDashboard(orgId);
  const severities = dashboard.topRisks.operational.map((r) => r.severity);
  assert.equal(severities[0], "critical");
});

test("getExecutiveComplianceDashboard reflects real control/vendor state, not a fabricated posture", async () => {
  const { control } = await createControl({ orgId, name: `Exec Dash Control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await updateControl({ orgId, controlId: control._id, updates: { status: "active" }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await createVendor({ orgId, name: `Exec Dash Vendor ${RUN_ID}`, service: "cloud", criticality: "critical", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const dashboard = await getExecutiveComplianceDashboard(orgId);
  assert.equal(dashboard.controlHealth.totalControls, 1);
  assert.equal(dashboard.vendorRisk.totalVendors, 1);
  assert.equal(dashboard.vendorRisk.criticalVendorsAtRisk, 1, "a freshly-created critical vendor is not yet MONITORING, so it counts as at-risk");
  assert.equal(dashboard.auditReadiness.status, "unknown", "no audit plans exist yet");
});
