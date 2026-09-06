// test/control-testing.test.mjs
//
// The Findings & Remediation state machine (SOW §130) -- transition
// legality (an illegal jump is rejected, not silently allowed) and the
// atomic-conflict guard (the same findOneAndUpdate({status: from})
// pattern every workflow in this app relies on, confirmed here to
// actually reject a stale-state transition attempt rather than silently
// overwriting).
//
// Run with: node --env-file=.env.local --test test/control-testing.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createControl } from "../src/lib/compliance-controls.js";
import { recordControlTest, transitionFinding, FINDING_STATES } from "../src/lib/control-testing.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `control-testing-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Control Testing Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
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

async function makeOpenFinding() {
  const { control } = await createControl({ orgId, name: `Control ${randomUUID().slice(0, 6)}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { finding } = await recordControlTest({ orgId, controlId: control._id, method: "manual", result: "fail", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return finding;
}

test("a failed control test auto-creates an OPEN finding", async () => {
  const finding = await makeOpenFinding();
  assert.equal(finding.status, "OPEN");
  assert.equal(finding.source, "control_test");
});

test("a passing control test never creates a finding", async () => {
  const { control } = await createControl({ orgId, name: `Passing control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { finding } = await recordControlTest({ orgId, controlId: control._id, method: "manual", result: "pass", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(finding, null);
});

test("SECURITY: an illegal transition (skipping states) is rejected, not silently allowed", async () => {
  const finding = await makeOpenFinding();
  // OPEN -> validate is not a legal transition (must go through assign,
  // startRemediation, submitForValidation first).
  const result = await transitionFinding({ orgId, findingId: finding._id, action: "validate", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 409);

  const stored = await collections.complianceFindings.findOne({ _id: finding._id });
  assert.equal(stored.status, "OPEN", "an illegal transition attempt must not change the stored status at all");
});

test("SECURITY: a transition against a stale/wrong 'from' state is rejected (the atomic findOneAndUpdate guard)", async () => {
  const finding = await makeOpenFinding();
  await transitionFinding({ orgId, findingId: finding._id, action: "assign", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  // Now ASSIGNED. Attempting "assign" again (which requires from:"OPEN")
  // must fail -- this is the exact class of bug a race condition would
  // otherwise exploit.
  const result = await transitionFinding({ orgId, findingId: finding._id, action: "assign", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 409);
});

test("the full legal path OPEN -> ASSIGNED -> IN_REMEDIATION -> READY_FOR_VALIDATION -> VALIDATED -> CLOSED succeeds end to end", async () => {
  const finding = await makeOpenFinding();
  const path = ["assign", "startRemediation", "submitForValidation", "validate", "close"];
  const expectedStates = ["ASSIGNED", "IN_REMEDIATION", "READY_FOR_VALIDATION", "VALIDATED", "CLOSED"];
  for (let i = 0; i < path.length; i++) {
    const result = await transitionFinding({ orgId, findingId: finding._id, action: path[i], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
    assert.equal(result.error, undefined, `transition "${path[i]}" should succeed: ${result.error}`);
    assert.equal(result.finding.status, expectedStates[i]);
  }
});

test("reopen is only legal from VALIDATED, taking a finding back to IN_REMEDIATION", async () => {
  const finding = await makeOpenFinding();
  for (const action of ["assign", "startRemediation", "submitForValidation", "validate"]) {
    await transitionFinding({ orgId, findingId: finding._id, action, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  }
  const result = await transitionFinding({ orgId, findingId: finding._id, action: "reopen", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error, undefined);
  assert.equal(result.finding.status, "IN_REMEDIATION");
});

test("sanity: FINDING_STATES matches the states this test suite exercises", () => {
  assert.deepEqual(FINDING_STATES, ["OPEN", "ASSIGNED", "IN_REMEDIATION", "READY_FOR_VALIDATION", "VALIDATED", "CLOSED"]);
});
