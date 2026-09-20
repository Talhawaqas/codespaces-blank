// test/live-migration.test.mjs
//
// Real, live end-to-end proof of the migration engine against a real
// running Inaya dev server (not mocked) -- exercising the exact same
// @aws-sdk/client-s3 code path a genuine AWS/GCS source would use.
//
// Honest scope note: this environment has no real AWS/Azure/GCP customer
// credentials available, so this test uses Inaya's OWN S3-compatible
// endpoint as the "source" too (createAwsSource pointed at Inaya instead
// of real AWS). That is a legitimate test of this engine's actual code
// path -- the S3 client and wire protocol are identical whether pointed
// at AWS or any other real S3-compatible server, which is the entire
// point of S3 compatibility -- but it is NOT a substitute for validating
// against genuine AWS/Azure/GCS source credentials, which requires real
// enterprise credentials this sandbox does not have. See the migration
// guide's own "What's proven, what isn't" section.
//
// Requires the dev server running at http://localhost:3000 (started via
// the Browser pane's preview_start in this session) and a real MongoDB
// connection via inaya-network-dapp's own .env.local.
//
// Run with:
//   node --env-file=../inaya-network-dapp/.env.local --test test/live-migration.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
// Deliberately NOT importing `mongodb`/ObjectId from this package's own
// node_modules -- doing so loads a SECOND, separate bson package instance
// alongside inaya-network-dapp's own, and the driver's serializer rejects
// an ObjectId built by a different bson instance ("BSONVersionError:
// Unsupported BSON version" -- a real dual-package-hazard bug found while
// writing this very test). Letting Mongo auto-generate _id on insert and
// reading it back from insertedId keeps every ObjectId in this test
// sourced from inaya-network-dapp's own single bson instance throughout.

import { createAwsSource } from "../src/adapters/aws.js";
import { createInayaDestination } from "../src/destination.js";
import { Manifest } from "../src/manifest.js";
import { runMigration } from "../src/migrate.js";

// Cross-package relative import -- both packages live in the same
// monorepo checkout; this is a dev-time test only, never shipped.
import { getOrgCollections, ensureOrgIndexes } from "../../inaya-network-dapp/src/lib/orgs.js";
import { issueS3Credential, ensureS3CompatIndexes } from "../../inaya-network-dapp/src/lib/s3-compat/credentials.js";

const ENDPOINT = "http://localhost:3000/api/s3";
const RUN_ID = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
});

after(async () => {
  const { orgs, departments, projects, orgDocuments, orgActivity, db } = collections;
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await db.collection("s3_credentials").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } });
  await db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } });
});

async function makeCredential(label) {
  const insertResult = await collections.orgs.insertOne({ name: `migration-agent-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  const orgId = insertResult.insertedId;
  cleanup.orgIds.push(orgId);
  const cred = await issueS3Credential({ owner: { type: "org", orgId: orgId.toString() }, label, actorEmail: "migration-test@example.com" });
  return cred;
}

async function tmpManifestPath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inaya-migrate-live-"));
  return path.join(dir, "manifest.jsonl");
}

test("end-to-end: seed a real 'source' Inaya org, migrate into a real 'destination' Inaya org, verify byte-identical content", async () => {
  const sourceCred = await makeCredential("source");
  const destCred = await makeCredential("dest");

  // Seed the "source" using the same destination writer as a raw client --
  // legitimate reuse, since createInayaDestination is just a thin real S3
  // client pointed at Inaya.
  const seedWriter = createInayaDestination({ endpoint: ENDPOINT, accessKeyId: sourceCred.accessKeyId, secretAccessKey: sourceCred.secretAccessKey, bucket: "src-bucket" });
  await seedWriter.ensureBucket();
  const fileA = Buffer.from(`file A content ${RUN_ID}`);
  const fileB = Buffer.from(`file B content ${RUN_ID} - ` + "x".repeat(5000)); // exercise a non-trivial size
  await seedWriter.putObject({ key: "docs/a.txt", body: fileA, contentType: "text/plain" });
  await seedWriter.putObject({ key: "docs/b.txt", body: fileB, contentType: "text/plain" });

  const source = createAwsSource({
    region: "us-east-1",
    accessKeyId: sourceCred.accessKeyId,
    secretAccessKey: sourceCred.secretAccessKey,
    bucket: "src-bucket",
    endpoint: ENDPOINT,
    forcePathStyle: true,
  });
  await source.assertReachable();

  const destination = createInayaDestination({ endpoint: ENDPOINT, accessKeyId: destCred.accessKeyId, secretAccessKey: destCred.secretAccessKey, bucket: "dest-bucket" });

  const manifestPath = await tmpManifestPath();
  const manifest = await Manifest.load(manifestPath);
  const events = [];
  const summary = await runMigration({ source, destination, manifest, onEvent: (e) => events.push(e) });

  assert.equal(summary.MIGRATED, 2, "both seeded objects should migrate");
  assert.equal(summary.FAILED, 0);
  const migratedEvents = events.filter((e) => e.type === "migrated");
  assert.equal(migratedEvents.length, 2);
  assert.ok(migratedEvents.some((e) => e.sourceKey === "docs/a.txt" && e.byteSize === fileA.length));
  assert.ok(migratedEvents.some((e) => e.sourceKey === "docs/b.txt" && e.byteSize === fileB.length));

  // Real content check, not just size: fetch the migrated object back out
  // of the real destination org and confirm it's byte-identical.
  const { getS3ObjectBody } = await import("../../inaya-network-dapp/src/lib/s3-compat/store.js");
  const destOrgId = cleanup.orgIds[1].toString();
  const result = await getS3ObjectBody({ orgId: destOrgId, bucket: "dest-bucket", key: "docs/a.txt" });
  assert.equal(Buffer.compare(result.buffer, fileA), 0, "migrated content must be byte-identical to the source");
});

test("resume: re-running with the same manifest skips already-migrated objects and does not duplicate them", async () => {
  const sourceCred = await makeCredential("resume-source");
  const destCred = await makeCredential("resume-dest");

  const seedWriter = createInayaDestination({ endpoint: ENDPOINT, accessKeyId: sourceCred.accessKeyId, secretAccessKey: sourceCred.secretAccessKey, bucket: "src-bucket" });
  await seedWriter.ensureBucket();
  await seedWriter.putObject({ key: "one.txt", body: Buffer.from("one"), contentType: "text/plain" });
  await seedWriter.putObject({ key: "two.txt", body: Buffer.from("two"), contentType: "text/plain" });

  const source = createAwsSource({ region: "us-east-1", accessKeyId: sourceCred.accessKeyId, secretAccessKey: sourceCred.secretAccessKey, bucket: "src-bucket", endpoint: ENDPOINT, forcePathStyle: true });
  const destination = createInayaDestination({ endpoint: ENDPOINT, accessKeyId: destCred.accessKeyId, secretAccessKey: destCred.secretAccessKey, bucket: "dest-bucket" });

  const manifestPath = await tmpManifestPath();

  const manifest1 = await Manifest.load(manifestPath);
  const summary1 = await runMigration({ source, destination, manifest: manifest1 });
  assert.equal(summary1.MIGRATED, 2);

  // Simulate a fresh process: reload the manifest from disk and run again.
  const manifest2 = await Manifest.load(manifestPath);
  const events2 = [];
  const summary2 = await runMigration({ source, destination, manifest: manifest2, onEvent: (e) => events2.push(e) });
  const skipEvents = events2.filter((e) => e.type === "skip");
  const migratedEvents2 = events2.filter((e) => e.type === "migrated");
  assert.equal(skipEvents.length, 2, "both objects must be recognized as already migrated on resume");
  assert.equal(migratedEvents2.length, 0, "resume must not re-migrate (and thus not duplicate) already-migrated objects");
  assert.equal(summary2.MIGRATED, 2, "manifest total stays at 2, not 4");
});

test("dry-run mode performs no writes to the destination", async () => {
  const sourceCred = await makeCredential("dryrun-source");
  const destCred = await makeCredential("dryrun-dest");

  const seedWriter = createInayaDestination({ endpoint: ENDPOINT, accessKeyId: sourceCred.accessKeyId, secretAccessKey: sourceCred.secretAccessKey, bucket: "src-bucket" });
  await seedWriter.ensureBucket();
  await seedWriter.putObject({ key: "only.txt", body: Buffer.from("data"), contentType: "text/plain" });

  const source = createAwsSource({ region: "us-east-1", accessKeyId: sourceCred.accessKeyId, secretAccessKey: sourceCred.secretAccessKey, bucket: "src-bucket", endpoint: ENDPOINT, forcePathStyle: true });
  const destination = createInayaDestination({ endpoint: ENDPOINT, accessKeyId: destCred.accessKeyId, secretAccessKey: destCred.secretAccessKey, bucket: "dest-bucket" });

  const manifestPath = await tmpManifestPath();
  const manifest = await Manifest.load(manifestPath);
  const events = [];
  await runMigration({ source, destination, manifest, dryRun: true, onEvent: (e) => events.push(e) });

  assert.ok(events.some((e) => e.type === "inventory" && e.key === "only.txt"));
  assert.equal(events.filter((e) => e.type === "migrated").length, 0);

  // The destination bucket must genuinely not exist -- dry-run never even
  // calls ensureBucket, let alone writes an object.
  const head = await destination.headObject({ key: "only.txt" });
  assert.equal(head, null, "dry-run must not have written anything to the destination");
});

test("failure handling: a source key that does not exist is recorded FAILED, not silently dropped", async () => {
  const sourceCred = await makeCredential("fail-source");
  const destCred = await makeCredential("fail-dest");

  const source = createAwsSource({ region: "us-east-1", accessKeyId: sourceCred.accessKeyId, secretAccessKey: sourceCred.secretAccessKey, bucket: "src-bucket", endpoint: ENDPOINT, forcePathStyle: true });
  const destination = createInayaDestination({ endpoint: ENDPOINT, accessKeyId: destCred.accessKeyId, secretAccessKey: destCred.secretAccessKey, bucket: "dest-bucket" });

  const manifestPath = await tmpManifestPath();
  const manifest = await Manifest.load(manifestPath);
  const events = [];
  const summary = await runMigration({ source, destination, manifest, objectKeys: ["never-uploaded.txt"], onEvent: (e) => events.push(e) });

  assert.equal(summary.FAILED, 1);
  const failedEvent = events.find((e) => e.type === "failed");
  assert.ok(failedEvent, "a nonexistent source object must produce a real FAILED record, not be silently skipped");
  assert.ok(failedEvent.failureReason, "failure must carry a real reason string");
});
