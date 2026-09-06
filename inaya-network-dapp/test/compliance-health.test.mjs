// test/compliance-health.test.mjs
//
// The single most load-bearing correctness property of the Regulated
// Enterprise Control Plane (SOW §191-192): a control with no test record
// is UNKNOWN, never silently counted as passing. This test was written
// to fail on a naive first draft that defaulted an untested control to
// "passing" — it now guards that regression permanently.
//
// Run with: node --env-file=.env.local --test test/compliance-health.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createControl } from "../src/lib/compliance-controls.js";
import { recordControlTest, transitionFinding } from "../src/lib/control-testing.js";
import { getComplianceHealth } from "../src/lib/compliance-health.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `compliance-health-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Compliance Health Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.complianceControls.deleteMany({ orgId }),
    collections.complianceControlTests.deleteMany({ orgId }),
    collections.complianceFindings.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: a control with zero test records is UNKNOWN, never PASSING", async () => {
  const { control } = await createControl({ orgId, name: `Untested control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const health = await getComplianceHealth(orgId);
  assert.ok(health.controlsUnknown >= 1, "the untested control must be counted as unknown");
  assert.equal(health.controlsPassing, 0, "an untested control must NEVER be counted as passing");
  await collections.complianceControls.deleteOne({ _id: control._id });
});

test("an organization with zero controls at all reports overallStatus 'unknown', never 'green'", async () => {
  // This test's own org has no controls yet (cleaned up by the prior test) —
  // confirms a control-free org is never fabricated as compliant.
  const health = await getComplianceHealth(orgId);
  assert.equal(health.totalControls, 0);
  assert.equal(health.overallStatus, "unknown", "a control-free org must report 'unknown', not 'green' -- there is no positive evidence of compliance yet");
});

test("a control that passes its test is counted as passing, and overallStatus can become green with no other issues", async () => {
  const { control } = await createControl({ orgId, name: `Passing control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordControlTest({ orgId, controlId: control._id, method: "manual", result: "pass", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const health = await getComplianceHealth(orgId);
  assert.equal(health.controlsPassing, 1);
  assert.equal(health.controlsFailing, 0);
  assert.equal(health.controlsUnknown, 0);
  assert.equal(health.overallStatus, "green");
});

test("a failing control drives overallStatus to 'red', and closing its auto-created finding does not fabricate a passing status", async () => {
  const { control } = await createControl({ orgId, name: `Failing control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { finding } = await recordControlTest({ orgId, controlId: control._id, method: "manual", result: "fail", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.ok(finding, "a failed test must auto-create a finding");

  let health = await getComplianceHealth(orgId);
  assert.equal(health.overallStatus, "red");
  assert.ok(health.controlsFailing >= 1);

  // Walk the finding to CLOSED -- the control's own last test result is
  // still "fail" until someone actually re-tests it. Closing the finding
  // must NOT silently flip the control back to passing.
  await transitionFinding({ orgId, findingId: finding._id, action: "assign", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionFinding({ orgId, findingId: finding._id, action: "startRemediation", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionFinding({ orgId, findingId: finding._id, action: "submitForValidation", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionFinding({ orgId, findingId: finding._id, action: "validate", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionFinding({ orgId, findingId: finding._id, action: "close", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  health = await getComplianceHealth(orgId);
  assert.ok(health.controlsFailing >= 1, "closing the finding must NOT change the control's own failing test result");
  assert.equal(health.remediationProgress.closed, health.remediationProgress.total, "the finding itself should show fully remediated");
});

test("remediationProgress.percentComplete is null (not 0) when there are zero findings -- 'no findings' is not '0% progress'", async () => {
  const { complianceFindings } = collections;
  await complianceFindings.deleteMany({ orgId });
  const health = await getComplianceHealth(orgId);
  assert.equal(health.remediationProgress.total, 0);
  assert.equal(health.remediationProgress.percentComplete, null);
});
