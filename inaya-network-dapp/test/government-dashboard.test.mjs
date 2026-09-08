// test/government-dashboard.test.mjs
//
// THE other load-bearing correctness property for this phase (mirrors
// compliance-health.test.mjs's precedent exactly): an org with no audit
// chain entries yet must report auditChainStatus "unknown", NEVER "valid"
// -- a fresh org with nothing to verify is not the same as a verified-healthy
// one. Same for avgResolutionDays with zero resolved cases.
//
// Run with: node --env-file=.env.local --test test/government-dashboard.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { getGovernmentDashboard } from "../src/lib/government-dashboard.js";
import { createCase, transitionCase } from "../src/lib/government-cases.js";
import { appendAuditEntry } from "../src/lib/auditChain.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `gov-dash-${RUN_ID}@example.com`;
const OWNER_MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Government Dashboard Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "government", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.governmentCases.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: a fresh org with zero audit chain entries reports auditChainStatus 'unknown', never 'valid' -- absence of evidence is not evidence of health", async () => {
  const dashboard = await getGovernmentDashboard(orgId);
  assert.equal(dashboard.security.auditChainStatus, "unknown");
  assert.equal(dashboard.security.auditChainEntryCount, 0);
});

test("once at least one audit chain entry exists and verifies, auditChainStatus reports 'valid'", async () => {
  await appendAuditEntry({ orgId, recordType: "TEST_EVENT", recordId: null, actorEmail: OWNER_EMAIL, action: "TEST", previousState: null, newState: null, metadata: {} });
  const dashboard = await getGovernmentDashboard(orgId);
  assert.equal(dashboard.security.auditChainStatus, "valid");
  assert.ok(dashboard.security.auditChainEntryCount >= 1);
});

test("a fresh org with zero resolved cases reports avgResolutionDays 'unknown', never a fabricated 0", async () => {
  await createCase({ orgId, category: "citizen_services", priority: "low", title: "Unresolved case", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const dashboard = await getGovernmentDashboard(orgId);
  assert.equal(dashboard.operations.avgResolutionDays, "unknown");
});

test("once a case is actually resolved, avgResolutionDays reports a real computed number", async () => {
  const { case: created } = await createCase({ orgId, category: "regulatory", priority: "low", title: "Will resolve", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "assign", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "start", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "submitForReview", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "resolve", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const dashboard = await getGovernmentDashboard(orgId);
  assert.equal(typeof dashboard.operations.avgResolutionDays, "number");
  assert.ok(dashboard.operations.avgResolutionDays >= 0);
});

test("dashboard never collapses operations and security into a single fabricated traffic-light score", async () => {
  const dashboard = await getGovernmentDashboard(orgId);
  assert.equal(dashboard.overallStatus, undefined, "there must be no aggregate green/yellow/red field -- operations and security stay separate, honest panels");
});
