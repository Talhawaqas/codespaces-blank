// test/nas-backup-retention.test.mjs -- off-site NAS recovery-point retention (21 Nov 2026). The backup policy's "keep N recovery
// points" used to be stored but never enforced, so off-site copies grew for ever. pruneRecoveryPoints keeps the newest N and deletes
// only stored versions that no kept recovery point (and no backup-index entry, which later runs reuse) still references.
// Runs against the real versioned store on the test database; no NAS appliance is needed.
process.env.S3_DEFAULT_TRIPWIRE = "off";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, getS3ObjectBody, putBucketVersioning } from "../src/lib/s3-compat/store.js";
import { pruneRecoveryPoints } from "../src/lib/nas/backup.js";

const orgId = new ObjectId(); const ORG = String(orgId); const applianceId = new ObjectId(); const shareId = new ObjectId();
const bucket = `nasbk-${Date.now().toString(36)}`;
let c; const v = {};
before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections();
  await c.orgs.insertOne({ _id: orgId, name: "nas-retention", createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: ORG });
  await putS3Object({ orgId: ORG, bucket, key: "seed.txt", bodyBuffer: Buffer.from("x"), actorEmail: "admin" });
  await putBucketVersioning({ orgId: ORG, bucket, status: "Enabled" });
  v.a1 = (await putS3Object({ orgId: ORG, bucket, key: "share/a.txt", bodyBuffer: Buffer.from("a version 1"), actorEmail: "admin" })).versionId;
  v.b1 = (await putS3Object({ orgId: ORG, bucket, key: "share/b.txt", bodyBuffer: Buffer.from("b version 1"), actorEmail: "admin" })).versionId;
  v.a2 = (await putS3Object({ orgId: ORG, bucket, key: "share/a.txt", bodyBuffer: Buffer.from("a version 2"), actorEmail: "admin" })).versionId;
  await c.nasAppliances.insertOne({ _id: applianceId, orgId, name: "retention test", backupBucket: bucket });
  await c.nasShares.insertOne({ _id: shareId, orgId, applianceId, shareName: "share", deletedAt: null });
  const f = (key, versionId) => ({ relativePath: key.split("/")[1], sizeBytes: 11, sha256: "x", objectKey: key, versionId });
  const run = (i, files) => ({ orgId, shareId, applianceId, targetKey: "inaya", status: "COMPLETED", startedAt: new Date(Date.now() - (10 - i) * 3600_000).toISOString(), completedAt: new Date(Date.now() - (10 - i) * 3600_000).toISOString(), recoveryPoint: { files } });
  // r1 uploaded a@1 and b@1; r2 and r3 reuse b@1 (deduplication) and point at a@2
  await c.nasBackupRuns.insertMany([run(1, [f("share/a.txt", v.a1), f("share/b.txt", v.b1)]), run(2, [f("share/a.txt", v.a2), f("share/b.txt", v.b1)]), run(3, [f("share/a.txt", v.a2), f("share/b.txt", v.b1)])]);
  await c.nasBackupIndex.insertMany([{ orgId, shareId, targetKey: "inaya", relativePath: "a.txt", objectKey: "share/a.txt", versionId: v.a2 }, { orgId, shareId, targetKey: "inaya", relativePath: "b.txt", objectKey: "share/b.txt", versionId: v.b1 }]);
});
after(async () => {
  for (const { name } of await c.db.listCollections({}, { nameOnly: true }).toArray()) await c.db.collection(name).deleteMany({ $or: [{ orgId }, { orgId: ORG }, { ownerId: ORG }] }).catch(() => {});
  await c.db.collection("orgs").deleteOne({ _id: orgId });
  await (await mongoClientPromise).close();
});

const body = (key, versionId) => getS3ObjectBody({ orgId: ORG, bucket, key, versionId }).then((r) => r?.buffer?.toString() ?? null).catch(() => null);

test("keeps the newest N recovery points; deletes only versions nothing kept still references", { timeout: 120000 }, async () => {
  const r = await pruneRecoveryPoints({ orgId: ORG, shareId, keep: 2 });
  assert.equal(r.pruned, 1); assert.equal(r.deletedVersions, 1); assert.deepEqual(r.failed, []);
  assert.equal(await body("share/a.txt", v.a1), null, "a@1 was only in the pruned recovery point: deleted");
  assert.equal(await body("share/b.txt", v.b1), "b version 1", "b@1 is reused by the kept recovery points: kept");
  assert.equal(await body("share/a.txt", v.a2), "a version 2", "the current version is kept");
  const runs = await c.nasBackupRuns.find({ orgId }).sort({ completedAt: 1 }).toArray();
  assert.deepEqual(runs.map((x) => x.status), ["PRUNED", "COMPLETED", "COMPLETED"]);
  assert.equal(runs[0].recoveryPoint.prunedFileCount, 2); assert.deepEqual(runs[0].recoveryPoint.files, []);
  const ev = await c.nasEvidence.findOne({ orgId, action: "RECOVERY_POINTS_PRUNED" }); assert.ok(ev, "the pruning is recorded as evidence");
});

test("running it again changes nothing; fewer recovery points than N are never pruned", async () => {
  assert.equal((await pruneRecoveryPoints({ orgId: ORG, shareId, keep: 2 })).pruned, 0);
  assert.equal((await pruneRecoveryPoints({ orgId: ORG, shareId, keep: 14 })).pruned, 0);
  assert.equal((await pruneRecoveryPoints({ orgId: ORG, shareId, keep: 0 })).pruned, 0, "an invalid keep value prunes nothing");
});
