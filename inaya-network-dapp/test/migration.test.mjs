// test/migration.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 10 (§273-274) —
// Migration. Load-bearing properties: planning validates but never
// writes; a partially-invalid batch still imports its valid rows and
// reports the rest as real, named failures (never silently dropped);
// execution only happens once APPROVED, by someone other than whoever
// planned it, and reconciliation numbers are real, computed counts.
//
// Run with: node --env-file=.env.local --test test/migration.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { planMigration, approveMigration, rejectMigration, executeMigration } from "../src/lib/migration.js";

const RUN_ID = randomUUID().slice(0, 8);
const PLANNER_EMAIL = `migration-planner-${RUN_ID}@example.com`;
const APPROVER_EMAIL = `migration-approver-${RUN_ID}@example.com`;
const PLANNER_MEMBERSHIP = { role: "owner", email: PLANNER_EMAIL };
const APPROVER_MEMBERSHIP = { role: "admin", email: APPROVER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Migration Test ${RUN_ID} Co`, ownerEmail: PLANNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = orgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.migrationRuns.deleteMany({ orgId }),
    collections.riskRegister.deleteMany({ orgId }),
    collections.vendorRecords.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("planMigration validates without writing anything to the target collection", async () => {
  const before = await collections.riskRegister.countDocuments({ orgId });
  const { migration } = await planMigration({
    orgId, recordType: "risk", sourceLabel: "legacy-grc-export.csv",
    records: [{ id: "1", category: "cyber", severity: "high" }, { id: "2", category: "operational", severity: "medium" }],
    actorEmail: PLANNER_EMAIL, membership: PLANNER_MEMBERSHIP,
  });
  assert.equal(migration.status, "PENDING_APPROVAL");
  assert.equal(migration.recordsTotal, 2);
  assert.equal(migration.failures.length, 0);

  const after = await collections.riskRegister.countDocuments({ orgId });
  assert.equal(after, before, "planning must never write to the destination collection");
});

test("a partially-invalid batch reports real, named failures for the bad rows and still validates the good ones", async () => {
  const { migration } = await planMigration({
    orgId, recordType: "vendor", sourceLabel: "legacy-vendors.csv",
    records: [
      { id: "v1", name: "CloudCo", service: "hosting" },
      { id: "v2", name: "Missing Service Co" }, // missing required `service`
      { id: "v3", service: "consulting" }, // missing required `name`
    ],
    actorEmail: PLANNER_EMAIL, membership: PLANNER_MEMBERSHIP,
  });
  assert.equal(migration.recordsTotal, 3);
  assert.equal(migration.failures.length, 2);
  assert.equal(migration.validatedRecords.length, 1);
  assert.match(migration.failures.find((f) => f.sourceId === "v2").reason, /service/);
  assert.match(migration.failures.find((f) => f.sourceId === "v3").reason, /name/);
});

test("an unknown record type is rejected with the supported list, not a silent no-op", async () => {
  const result = await planMigration({ orgId, recordType: "not_a_real_type", records: [{ id: "1" }], actorEmail: PLANNER_EMAIL, membership: PLANNER_MEMBERSHIP });
  assert.equal(result.status, 400);
  assert.match(result.error, /control|vendor|risk/);
});

test("SECURITY: the approver must be a different person than whoever planned the migration", async () => {
  const { migration } = await planMigration({ orgId, recordType: "risk", records: [{ id: "1", category: "cyber", severity: "high" }], actorEmail: PLANNER_EMAIL, membership: PLANNER_MEMBERSHIP });
  const selfApprove = await approveMigration({ orgId, migrationId: migration._id, actorEmail: PLANNER_EMAIL, membership: PLANNER_MEMBERSHIP });
  assert.equal(selfApprove.status, 403);

  const realApprove = await approveMigration({ orgId, migrationId: migration._id, actorEmail: APPROVER_EMAIL, membership: APPROVER_MEMBERSHIP });
  assert.equal(realApprove.migration.status, "APPROVED");
});

test("executeMigration only runs once APPROVED, writes exactly the validated records, and computes real reconciliation counts", async () => {
  const beforeCount = await collections.riskRegister.countDocuments({ orgId });
  const { migration: planned } = await planMigration({
    orgId, recordType: "risk", sourceLabel: "legacy2.csv",
    records: [{ id: "a", category: "cyber", severity: "critical" }, { id: "b", category: "financial", severity: "high" }],
    actorEmail: PLANNER_EMAIL, membership: PLANNER_MEMBERSHIP,
  });

  const notYetApproved = await executeMigration({ orgId, migrationId: planned._id, actorEmail: APPROVER_EMAIL, membership: APPROVER_MEMBERSHIP });
  assert.equal(notYetApproved.status, 409);

  await approveMigration({ orgId, migrationId: planned._id, actorEmail: APPROVER_EMAIL, membership: APPROVER_MEMBERSHIP });
  const { migration: completed } = await executeMigration({ orgId, migrationId: planned._id, actorEmail: APPROVER_EMAIL, membership: APPROVER_MEMBERSHIP });

  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.reconciliation.newRecords, 2);
  assert.equal(completed.reconciliation.sourceCount, 2);
  assert.ok(completed.completedAt);

  const afterCount = await collections.riskRegister.countDocuments({ orgId });
  assert.equal(afterCount, beforeCount + 2);

  const secondExecute = await executeMigration({ orgId, migrationId: planned._id, actorEmail: APPROVER_EMAIL, membership: APPROVER_MEMBERSHIP });
  assert.equal(secondExecute.status, 409, "a COMPLETED migration can never be executed twice");
});

test("rejectMigration moves a pending run to REJECTED and it can never be approved or executed afterward", async () => {
  const { migration } = await planMigration({ orgId, recordType: "risk", records: [{ id: "1", category: "cyber", severity: "low" }], actorEmail: PLANNER_EMAIL, membership: PLANNER_MEMBERSHIP });
  const { migration: rejected } = await rejectMigration({ orgId, migrationId: migration._id, actorEmail: APPROVER_EMAIL, membership: APPROVER_MEMBERSHIP, reason: "wrong source system" });
  assert.equal(rejected.status, "REJECTED");

  const lateApprove = await approveMigration({ orgId, migrationId: migration._id, actorEmail: APPROVER_EMAIL, membership: APPROVER_MEMBERSHIP });
  assert.equal(lateApprove.status, 409);
});
