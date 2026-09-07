// test/regulated-export-package.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 10 (§218) —
// Regulated Export Package. Load-bearing properties: a package can only
// be generated for an APPROVED export request, and verifyRegulatedExportPackage()
// must genuinely recompute the hash rather than trust the stored one --
// tampering the stored records must be detectable.
//
// Run with: node --env-file=.env.local --test test/regulated-export-package.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { requestExport, decideExport } from "../src/lib/export-center.js";
import { generateRegulatedExportPackage, verifyRegulatedExportPackage, listRegulatedExportPackages } from "../src/lib/regulated-export-package.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `rep-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Regulated Export Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = orgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.exportRequests.deleteMany({ orgId }),
    collections.regulatedExportPackages.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: a package cannot be generated for a request that isn't APPROVED", async () => {
  const { request } = await requestExport({ orgId, reason: "test", scope: {}, format: "json", actorEmail: OWNER_EMAIL });
  const result = await generateRegulatedExportPackage({ orgId, requestId: request._id, recordType: "risk", records: [{ id: "r1" }], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.status, 409);
});

test("generateRegulatedExportPackage produces the full §218 shape and marks the underlying request GENERATED", async () => {
  const { request } = await requestExport({ orgId, reason: "board reporting", scope: {}, format: "json", actorEmail: OWNER_EMAIL });
  await decideExport({ orgId, requestId: request._id, approve: true, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const records = [{ id: "risk-1", category: "cyber", severity: "high" }, { id: "risk-2", category: "operational", severity: "low" }];
  const { package: pkg } = await generateRegulatedExportPackage({ orgId, requestId: request._id, recordType: "risk", records, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  assert.equal(pkg.manifest.source, "Inaya Sovereign Enterprise OS");
  assert.equal(pkg.manifest.recordCount, 2);
  assert.ok(pkg.manifest.version);
  assert.ok(pkg.manifest.generatedAt);
  assert.equal(pkg.authorization.approvedByEmail, OWNER_EMAIL);
  assert.ok("chainVerificationResult" in pkg);
  assert.ok(pkg.hash);

  const { exportRequests } = collections;
  const updatedRequest = await exportRequests.findOne({ _id: request._id });
  assert.equal(updatedRequest.status, "GENERATED");
});

test("SECURITY: verifyRegulatedExportPackage detects tampering -- a mutated stored record fails re-verification", async () => {
  const { request } = await requestExport({ orgId, reason: "test", scope: {}, format: "json", actorEmail: OWNER_EMAIL });
  await decideExport({ orgId, requestId: request._id, approve: true, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { package: pkg } = await generateRegulatedExportPackage({ orgId, requestId: request._id, recordType: "risk", records: [{ id: "risk-1", category: "cyber", severity: "high" }], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const cleanVerify = await verifyRegulatedExportPackage(orgId, pkg._id);
  assert.equal(cleanVerify.valid, true);

  const { regulatedExportPackages } = collections;
  await regulatedExportPackages.updateOne({ _id: pkg._id }, { $set: { "records.0.severity": "low" } }); // simulate tampering
  const tamperedVerify = await verifyRegulatedExportPackage(orgId, pkg._id);
  assert.equal(tamperedVerify.valid, false, "a tampered record must fail re-verification, not silently pass");
});

test("listRegulatedExportPackages filters by requestId", async () => {
  const { request } = await requestExport({ orgId, reason: "test", scope: {}, format: "json", actorEmail: OWNER_EMAIL });
  await decideExport({ orgId, requestId: request._id, approve: true, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await generateRegulatedExportPackage({ orgId, requestId: request._id, recordType: "risk", records: [{ id: "risk-1", category: "cyber", severity: "high" }], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const packages = await listRegulatedExportPackages(orgId, { requestId: request._id });
  assert.equal(packages.length, 1);
});
