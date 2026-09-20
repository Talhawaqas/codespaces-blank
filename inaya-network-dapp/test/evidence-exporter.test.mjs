// test/evidence-exporter.test.mjs
//
// Enterprise Adoption SOW, Workstream C -- real DB-backed tests for the
// compliance evidence exporter: completeness, determinism, integrity
// verification, and (critically) that generating an export never mutates
// any storage/security primitive it reads from.
//
// Run with: node --env-file=.env.local --test test/evidence-exporter.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, putBucketVersioning, putLifecyclePolicy } from "../src/lib/s3-compat/store.js";
import { appendAuditEntry } from "../src/lib/auditChain.js";
import { buildEvidencePackage, canonicalizeForExport } from "../src/lib/evidenceExporter.js";

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
  await db.collection("audit_chain_entries").deleteMany({ orgId: { $in: cleanup.orgIds } });
  await db.collection("audit_chain_heads").deleteMany({ orgId: { $in: cleanup.orgIds } });
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `evidence-export-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  return orgId.toString();
}

test("canonicalizeForExport is deterministic regardless of key insertion order", () => {
  const a = { z: 1, a: { y: 2, x: 3 }, m: [3, 1, 2] };
  const b = { a: { x: 3, y: 2 }, m: [3, 1, 2], z: 1 };
  assert.equal(canonicalizeForExport(a), canonicalizeForExport(b));
});

test("evidence package includes real bucket protection state (versioning, lifecycle)", async () => {
  const orgId = await makeTestOrg("storage-evidence");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  await putS3Object({ orgId, bucket: "evidence-bucket", key: "a.txt", bodyBuffer: Buffer.from("data"), contentType: "text/plain", actorEmail: "t" });
  await putBucketVersioning({ orgId, bucket: "evidence-bucket", status: "Enabled" });
  await putLifecyclePolicy({ orgId, bucket: "evidence-bucket", rules: [{ prefix: "", expirationDays: 90 }], actorEmail: "t" });

  const pkg = await buildEvidencePackage({ orgId, actorEmail: "auditor@example.com" });
  const bucketEntry = pkg.storageEvidence.buckets.find((b) => b.bucket === "evidence-bucket");
  assert.ok(bucketEntry, "the real bucket must appear in storage evidence");
  assert.equal(bucketEntry.versioningStatus, "Enabled");
  assert.equal(bucketEntry.lifecycleRules.length, 1);
});

test("evidence package includes real audit chain entries and a genuine integrity verification result", async () => {
  const orgId = await makeTestOrg("audit-evidence");
  await appendAuditEntry({ orgId, recordType: "test_record", recordId: new ObjectId(), actorEmail: "t@example.com", action: "TEST_EVENT", metadata: {} });

  const pkg = await buildEvidencePackage({ orgId, actorEmail: "auditor@example.com" });
  assert.equal(pkg.auditEvidence.chainIntegrity.valid, true);
  assert.ok(pkg.auditEvidence.entries.some((e) => e.action === "TEST_EVENT"));
});

test("export hash changes if the underlying evidence changes, and matches a recomputation of the same package", async () => {
  const orgId = await makeTestOrg("export-hash");
  const pkg1 = await buildEvidencePackage({ orgId, actorEmail: "auditor@example.com" });

  // Recompute the hash from the SAME returned object (excluding the hash
  // field itself) and confirm it matches -- proves the hash genuinely
  // commits to the document content, not an unrelated random value.
  const { exportHash, ...rest } = pkg1;
  const recomputed = (await import("node:crypto")).createHash("sha256").update(canonicalizeForExport(rest), "utf8").digest("hex");
  assert.equal(recomputed, exportHash);

  await appendAuditEntry({ orgId, recordType: "test_record", recordId: new ObjectId(), actorEmail: "t@example.com", action: "SOMETHING_NEW", metadata: {} });
  const pkg2 = await buildEvidencePackage({ orgId, actorEmail: "auditor@example.com" });
  assert.notEqual(pkg2.exportHash, pkg1.exportHash, "adding a real new audit entry must change the export hash");
});

test("generating an export does not mutate any storage or security primitive it reads (read-only requirement)", async () => {
  const orgId = await makeTestOrg("read-only");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  await putS3Object({ orgId, bucket: "readonly-bucket", key: "a.txt", bodyBuffer: Buffer.from("data"), contentType: "text/plain", actorEmail: "t" });
  await putBucketVersioning({ orgId, bucket: "readonly-bucket", status: "Enabled" });

  const { orgDocuments, db } = collections;
  const beforeDocs = await orgDocuments.find({ orgId: new ObjectId(orgId) }).toArray();
  const beforeVersioning = await db.collection("projects").findOne({ orgId: new ObjectId(orgId), name: "readonly-bucket" });

  await buildEvidencePackage({ orgId, actorEmail: "auditor@example.com" });

  const afterDocs = await orgDocuments.find({ orgId: new ObjectId(orgId) }).toArray();
  const afterVersioning = await db.collection("projects").findOne({ orgId: new ObjectId(orgId), name: "readonly-bucket" });
  assert.deepEqual(
    beforeDocs.map((d) => ({ filename: d.filename, deletedAt: d.deletedAt, isLatest: d.isLatest })),
    afterDocs.map((d) => ({ filename: d.filename, deletedAt: d.deletedAt, isLatest: d.isLatest })),
    "buildEvidencePackage must not alter any org_documents row"
  );
  assert.deepEqual(beforeVersioning, afterVersioning, "buildEvidencePackage must not alter bucket configuration");
});
