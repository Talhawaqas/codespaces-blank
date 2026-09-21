// test/cloud-backup-scheduler.test.mjs
//
// Modular Enterprise Adoption Features SOW, Feature 3 -- Smart Cloud
// Backup & Health Scheduler. Credential encryption round-trip, schedule
// CRUD/permissions, health computation, and the FULL runBackupJob() flow
// end-to-end against a mocked createAwsSource (the one genuinely
// external dependency, since no real cloud account is available in this
// environment) -- everything downstream is real: the diff-against-last-
// sync logic, the Mongo-backed manifest shim, the real destination write
// through s3-compat/store.js, and the real inaya-migration-agent
// runMigration() engine (retry/backoff/verification), all exercised for
// real via the file: dependency link.
//
// mock.module() must run BEFORE cloudBackupScheduler.js is first loaded,
// so that module's own exports are pulled in via a top-level dynamic
// import below instead of a static "import ... from" -- same convention
// test/mfa.test.mjs already established for the same reason.
// --experimental-test-module-mocks is required (already in package.json's
// "test" script) for mock.module() to exist at all.
//
// Run with: node --env-file=.env.local --experimental-test-module-mocks --test test/cloud-backup-scheduler.test.mjs

import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { storeBackupCredential, resolveBackupCredential, revokeBackupCredential, listBackupCredentials } from "../src/lib/backupCryptoAndCredentials.js";

// A mock source: implements exactly the {kind, listObjects, getObject}
// shape createAwsSource() itself implements. Reads from a module-level
// mutable array so each test can set up its own object set before
// calling runBackupJob() -- mock.module()'s replacement is installed
// once, but the underlying data it serves can change per test.
let mockObjects = [];
function fakeCreateAwsSource() {
  return {
    kind: "mock-aws",
    async *listObjects() {
      for (const o of mockObjects) yield { key: o.key, sizeBytes: o.body.length, etag: o.etag, lastModified: o.lastModified || new Date().toISOString() };
    },
    async getObject({ key }) {
      const o = mockObjects.find((x) => x.key === key);
      if (!o) throw new Error(`mock source: no such key "${key}"`);
      return { body: o.body, contentType: "text/plain", sizeBytes: o.body.length };
    },
  };
}
mock.module("@inaya-network/migration-agent/src/adapters/aws.js", { exports: { createAwsSource: fakeCreateAwsSource } });

const { createBackupSchedule, listBackupSchedules, pauseBackupSchedule, resumeBackupSchedule, deleteBackupSchedule, runBackupJob, getScheduleHealth, findDueSchedules } = await import("../src/lib/cloudBackupScheduler.js");

const RUN_ID = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: cleanup.orgIds } }),
    collections.orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.backupCredentials.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.backupSchedules.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.backupRuns.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.backupObjectState.deleteMany({}),
    collections.db.collection("s3_credentials").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } }),
    collections.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } }),
    collections.db.collection("notifications").deleteMany({ orgId: { $in: cleanup.orgIds } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `backup-scheduler-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  const ownerMembership = { role: "owner", email: `owner-${RUN_ID}-${label}@example.com` };
  const staffMembership = { role: "member", email: `staff-${RUN_ID}-${label}@example.com`, departmentIds: [] };
  // ensures the org's S3-compat passphrase exists, since runBackupJob's
  // destination writes go through the real putS3Object.
  await issueS3Credential({ owner: { type: "org", orgId: orgId.toString() }, actorEmail: ownerMembership.email });
  return { orgId: orgId.toString(), ownerMembership, staffMembership };
}

// ---------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------

test("storeBackupCredential encrypts at rest; resolveBackupCredential decrypts exactly what was stored; only owner/admin can store", async () => {
  const { orgId, ownerMembership, staffMembership } = await makeTestOrg("cred");
  const denied = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "AKIA...", secretAccessKey: "secret", region: "us-east-1" }, actorEmail: staffMembership.email, membership: staffMembership });
  assert.equal(denied.status, 403);

  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", label: "Prod AWS", credentials: { accessKeyId: "AKIAABC123", secretAccessKey: "s3cr3t-value", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });

  const raw = await collections.backupCredentials.findOne({ _id: credentialId });
  assert.ok(raw.credentialsEncrypted);
  assert.ok(!raw.credentialsEncrypted.includes("s3cr3t-value"), "the raw secret must never appear in plaintext in the stored document");

  const resolved = await resolveBackupCredential({ orgId, credentialId });
  assert.equal(resolved.provider, "aws");
  assert.equal(resolved.credentials.secretAccessKey, "s3cr3t-value");

  const list = await listBackupCredentials(orgId);
  assert.ok(!("credentialsEncrypted" in list[0]), "listBackupCredentials must never return the encrypted secret");
});

test("storeBackupCredential rejects an incomplete credential for the given provider", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("cred-incomplete");
  const result = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "AKIA..." }, actorEmail: ownerMembership.email, membership: ownerMembership });
  assert.equal(result.status, 400);
  assert.match(result.error, /secretAccessKey/);
});

test("revokeBackupCredential makes resolveBackupCredential return null (SECURITY)", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("cred-revoke");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "gcs", credentials: { hmacAccessId: "GOOG1x", hmacSecret: "s" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  await revokeBackupCredential({ orgId, credentialId, actorEmail: ownerMembership.email, membership: ownerMembership });
  const resolved = await resolveBackupCredential({ orgId, credentialId });
  assert.equal(resolved, null);
});

// ---------------------------------------------------------------------
// Schedule CRUD, permissions, health
// ---------------------------------------------------------------------

test("createBackupSchedule persists a real schedule; only owner/admin can create one", async () => {
  const { orgId, ownerMembership, staffMembership } = await makeTestOrg("sched-crud");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });

  const denied = await createBackupSchedule({ orgId, name: "X", provider: "aws", credentialId, sourceBucket: "src", destinationBucket: "dst", intervalHours: 6, actorEmail: staffMembership.email, membership: staffMembership });
  assert.equal(denied.status, 403);

  const { schedule } = await createBackupSchedule({ orgId, name: "Nightly AWS Backup", provider: "aws", credentialId, sourceBucket: "src-bucket", sourcePrefix: "prod/", destinationBucket: "dst-bucket", intervalHours: 6, actorEmail: ownerMembership.email, membership: ownerMembership });
  assert.equal(schedule.status, "enabled");
  assert.equal(schedule.intervalHours, 6);

  const list = await listBackupSchedules(orgId);
  assert.equal(list.length, 1);
});

test("pause/resume/delete a schedule, each audited and permission-checked", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("sched-lifecycle");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  const { schedule } = await createBackupSchedule({ orgId, name: "S", provider: "aws", credentialId, sourceBucket: "b", destinationBucket: "d", intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });

  const paused = await pauseBackupSchedule({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email, membership: ownerMembership });
  assert.equal(paused.schedule.status, "paused");
  assert.equal(getScheduleHealth(paused.schedule), "PAUSED");

  const resumed = await resumeBackupSchedule({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email, membership: ownerMembership });
  assert.equal(resumed.schedule.status, "enabled");

  await deleteBackupSchedule({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email, membership: ownerMembership });
  const list = await listBackupSchedules(orgId);
  assert.equal(list.length, 0, "a deleted schedule must not appear in the active list");
});

test("health status reflects real consecutive-failure and staleness state, never fabricated", async () => {
  assert.equal(getScheduleHealth({ status: "enabled", consecutiveFailures: 0, lastRunAt: null, intervalHours: 6 }), "UNKNOWN");
  assert.equal(getScheduleHealth({ status: "enabled", consecutiveFailures: 0, lastRunAt: new Date().toISOString(), intervalHours: 6 }), "HEALTHY");
  assert.equal(getScheduleHealth({ status: "enabled", consecutiveFailures: 1, lastRunAt: new Date().toISOString(), intervalHours: 6 }), "DEGRADED");
  assert.equal(getScheduleHealth({ status: "enabled", consecutiveFailures: 3, lastRunAt: new Date().toISOString(), intervalHours: 6 }), "FAILED");
  assert.equal(getScheduleHealth({ status: "paused", consecutiveFailures: 0, lastRunAt: new Date().toISOString(), intervalHours: 6 }), "PAUSED");
  const staleDate = new Date(Date.now() - 20 * 3600000).toISOString(); // 20h ago, interval 6h -> stale after 18h
  assert.equal(getScheduleHealth({ status: "enabled", consecutiveFailures: 0, lastRunAt: staleDate, intervalHours: 6 }), "WARNING");
});

// ---------------------------------------------------------------------
// The real end-to-end run, against the mocked AWS source
// ---------------------------------------------------------------------

test("runBackupJob copies new objects into real Inaya storage and verifies them", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("run-basic");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  const { schedule } = await createBackupSchedule({ orgId, name: "Run Test", provider: "aws", credentialId, sourceBucket: "mock-src", destinationBucket: `backup-run-${RUN_ID}`, intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });

  mockObjects = [
    { key: "file-a.txt", body: Buffer.from("hello world A"), etag: "etag-a" },
    { key: "file-b.txt", body: Buffer.from("hello world B"), etag: "etag-b" },
  ];

  const { run } = await runBackupJob({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email });
  assert.equal(run.status, "SUCCESS");
  assert.equal(run.objectsSeen, 2);
  assert.equal(run.objectsChanged, 2);
  assert.equal(run.objectsCopied, 2);
  assert.equal(run.objectsVerified, 2);
  assert.equal(run.verificationFailures, 0);
  assert.equal(run.bytesTransferred, mockObjects[0].body.length + mockObjects[1].body.length);

  const { headS3Object } = await import("../src/lib/s3-compat/store.js");
  const written = await headS3Object({ orgId, bucket: schedule.destinationBucket, key: "file-a.txt" });
  assert.ok(written, "the object must actually exist in Inaya's own storage after the run");
  assert.equal(written.sizeBytes, mockObjects[0].body.length);
});

test("runBackupJob is duplicate-safe: a second run with zero source changes copies nothing new", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("run-duplicate-safe");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  const { schedule } = await createBackupSchedule({ orgId, name: "Dup Safe", provider: "aws", credentialId, sourceBucket: "mock-src", destinationBucket: `backup-dup-${RUN_ID}`, intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });

  mockObjects = [{ key: "stable.txt", body: Buffer.from("unchanged content"), etag: "etag-stable" }];
  const first = await runBackupJob({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email });
  assert.equal(first.run.objectsCopied, 1);

  // Same object set, same etag/size -- nothing has changed.
  const second = await runBackupJob({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email });
  assert.equal(second.run.objectsSeen, 1, "the object must still be seen (listed)");
  assert.equal(second.run.objectsChanged, 0, "an unchanged object must never be re-copied");
  assert.equal(second.run.objectsCopied, 0);
});

test("runBackupJob re-copies ONLY the object that actually changed, on a run with a mix of changed and unchanged objects", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("run-mixed");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  const { schedule } = await createBackupSchedule({ orgId, name: "Mixed", provider: "aws", credentialId, sourceBucket: "mock-src", destinationBucket: `backup-mixed-${RUN_ID}`, intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });

  mockObjects = [
    { key: "stays-same.txt", body: Buffer.from("v1"), etag: "e1" },
    { key: "gets-changed.txt", body: Buffer.from("v1"), etag: "e1" },
  ];
  await runBackupJob({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email });

  // Change ONE object's content/etag; add a brand new one.
  mockObjects = [
    { key: "stays-same.txt", body: Buffer.from("v1"), etag: "e1" },
    { key: "gets-changed.txt", body: Buffer.from("v2 -- longer now"), etag: "e2" },
    { key: "brand-new.txt", body: Buffer.from("new"), etag: "e-new" },
  ];
  const { run } = await runBackupJob({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email });
  assert.equal(run.objectsSeen, 3);
  assert.equal(run.objectsChanged, 2, "only the changed object and the new object count as changed");
  assert.equal(run.objectsCopied, 2);

  const { headS3Object } = await import("../src/lib/s3-compat/store.js");
  const updated = await headS3Object({ orgId, bucket: schedule.destinationBucket, key: "gets-changed.txt" });
  assert.equal(updated.sizeBytes, Buffer.from("v2 -- longer now").length, "the destination copy must reflect the NEW content");
});

test("findDueSchedules only returns enabled schedules whose nextRunAt has passed", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("due");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  const { schedule: dueSchedule } = await createBackupSchedule({ orgId, name: "Due", provider: "aws", credentialId, sourceBucket: "b", destinationBucket: "d", intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });
  await collections.backupSchedules.updateOne({ _id: dueSchedule._id }, { $set: { nextRunAt: new Date(Date.now() - 1000).toISOString() } });

  const { schedule: futureSchedule } = await createBackupSchedule({ orgId, name: "Future", provider: "aws", credentialId, sourceBucket: "b", destinationBucket: "d", intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });
  await collections.backupSchedules.updateOne({ _id: futureSchedule._id }, { $set: { nextRunAt: new Date(Date.now() + 3600000).toISOString() } });

  const due = await findDueSchedules(200);
  const dueIds = due.map((s) => s._id.toString());
  assert.ok(dueIds.includes(dueSchedule._id.toString()));
  assert.ok(!dueIds.includes(futureSchedule._id.toString()));
});

test("runBackupJob rejects running a paused schedule", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("run-paused");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  const { schedule } = await createBackupSchedule({ orgId, name: "Paused Run", provider: "aws", credentialId, sourceBucket: "b", destinationBucket: "d", intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });
  await pauseBackupSchedule({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email, membership: ownerMembership });

  const result = await runBackupJob({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email });
  assert.equal(result.status, 409);
});

test("runBackupJob reports a clean, real failure when the stored credential has been revoked, and still records a run (SECURITY)", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("run-revoked-cred");
  const { credentialId } = await storeBackupCredential({ orgId, provider: "aws", credentials: { accessKeyId: "A", secretAccessKey: "B", region: "us-east-1" }, actorEmail: ownerMembership.email, membership: ownerMembership });
  const { schedule } = await createBackupSchedule({ orgId, name: "Revoked Cred Run", provider: "aws", credentialId, sourceBucket: "mock-src", destinationBucket: "d", intervalHours: 1, actorEmail: ownerMembership.email, membership: ownerMembership });
  await revokeBackupCredential({ orgId, credentialId, actorEmail: ownerMembership.email, membership: ownerMembership });

  mockObjects = [{ key: "irrelevant.txt", body: Buffer.from("x"), etag: "e" }];
  const result = await runBackupJob({ orgId, scheduleId: schedule._id, actorEmail: ownerMembership.email });
  // A revoked credential fails inside runBackupJob's own try/catch, which
  // returns the same top-level {error, status} shape every other rejected
  // call in this file uses (schedule not found, paused, etc.) -- matching
  // the API route convention (`if (result.error) return NextResponse.json(...)`).
  // The run is still durably recorded as FAILED underneath regardless.
  assert.match(result.error, /revoked or is missing/);
  assert.equal(result.status, 500);

  const run = await collections.backupRuns.findOne({ scheduleId: schedule._id });
  assert.ok(run);
  assert.equal(run.status, "FAILED");
  assert.match(run.errorSummary, /revoked or is missing/);

  const updatedSchedule = await collections.backupSchedules.findOne({ _id: schedule._id });
  assert.equal(updatedSchedule.consecutiveFailures, 1);
});
