// test/disaster-recovery.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§69) — load-
// bearing correctness property: listRunbooksNeedingAttention() must
// never present a runbook as "recovery ready" when the real evidence
// says otherwise -- a never-tested runbook, a failed test, or an open
// retest requirement all surface honestly, and a genuinely passing,
// no-retest-needed runbook does NOT appear at all.
//
// Run with: node --env-file=.env.local --test test/disaster-recovery.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createRunbook, recordDrTest, listRunbooksNeedingAttention } from "../src/lib/disaster-recovery.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `disaster-recovery-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Disaster Recovery Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "general", createdAt: now });
  orgId = orgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.drRunbooks.deleteMany({ orgId }),
    collections.drTests.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function attentionFor(runbookId) {
  const all = await listRunbooksNeedingAttention(orgId);
  return all.find((a) => a.runbook._id.toString() === runbookId.toString());
}

test("a never-tested runbook needs attention with reason 'never_tested'", async () => {
  const { runbook } = await createRunbook({ orgId, name: `Core DB Recovery ${RUN_ID}`, restorationProcedure: "Restore from latest snapshot, replay WAL.", recoveryTimeObjectiveHours: 4, recoveryPointObjectiveHours: 1, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const attention = await attentionFor(runbook._id);
  assert.notEqual(attention, undefined);
  assert.equal(attention.reason, "never_tested");
});

test("a runbook whose latest test FAILED needs attention, even if an earlier test passed", async () => {
  const { runbook } = await createRunbook({ orgId, name: `Auth Service Recovery ${RUN_ID}`, restorationProcedure: "Redeploy from last known-good image.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordDrTest({ orgId, runbookId: runbook._id, result: "pass", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordDrTest({ orgId, runbookId: runbook._id, result: "fail", findings: ["Restore took 6h, exceeds RTO"], remediation: "Add read replica for faster failover", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const attention = await attentionFor(runbook._id);
  assert.notEqual(attention, undefined, "the most recent test result (fail) must govern, not an earlier pass");
  assert.equal(attention.reason, "last_test_failed");
});

test("a runbook whose latest test passed but flagged retestRequired still needs attention", async () => {
  const { runbook } = await createRunbook({ orgId, name: `File Storage Recovery ${RUN_ID}`, restorationProcedure: "Re-shard from surviving replicas.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordDrTest({ orgId, runbookId: runbook._id, result: "pass", retestRequired: true, remediation: "Verify after infra migration completes", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const attention = await attentionFor(runbook._id);
  assert.notEqual(attention, undefined, "a 'pass' result does not clear an explicit retestRequired flag");
  assert.equal(attention.reason, "retest_required");
});

test("a runbook with a genuinely passing, no-retest-needed test does NOT appear in the attention list", async () => {
  const { runbook } = await createRunbook({ orgId, name: `Cache Layer Recovery ${RUN_ID}`, restorationProcedure: "Warm cache from source DB on restart.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordDrTest({ orgId, runbookId: runbook._id, result: "pass", retestRequired: false, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const attention = await attentionFor(runbook._id);
  assert.equal(attention, undefined, "a genuinely clean pass must not be flagged for attention");
});

test("DR test records are immutable -- each recordDrTest() call is a new row, never an edit of a prior test", async () => {
  const { runbook } = await createRunbook({ orgId, name: `Message Queue Recovery ${RUN_ID}`, restorationProcedure: "Replay from durable log.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { test: t1 } = await recordDrTest({ orgId, runbookId: runbook._id, result: "pass", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { test: t2 } = await recordDrTest({ orgId, runbookId: runbook._id, result: "fail", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.notEqual(t1._id.toString(), t2._id.toString());

  const t1Stored = await collections.drTests.findOne({ _id: t1._id });
  assert.equal(t1Stored.result, "pass", "the first test's stored result must be unaffected by recording a second test");
});
