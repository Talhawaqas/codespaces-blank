// test/ransomware-containment-deletes.test.mjs -- (1) rollback restores the content from BEFORE the attack, against the real
// store; (2) a contained (paused) credential cannot DELETE either (found by the Enterprise
// Resilience Demonstration rehearsal, 21 Nov 2026): the S3 and Azure DELETE routes, the S3 multi-object delete, folder delete
// and multipart completion did not pass the caller, so containment (and delete detection) was skipped for them.
process.env.FEATURE_RANSOMWARE_SIGNALS = "on";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, deleteS3Object, deleteS3Folder, completeMultipartUpload, getS3ObjectBody } from "../src/lib/s3-compat/store.js";
import { randomBytes } from "node:crypto";
import * as R from "../src/lib/ransomware/cloud.js";

const orgId = new ObjectId(); const ORG = String(orgId); const actor = `AKIACONTAIN${Date.now().toString(36)}`.toUpperCase();
before(async () => {
  await ensureOrgIndexes(); const c = await getOrgCollections();
  await c.orgs.insertOne({ _id: orgId, name: "containment-deletes", createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: ORG }); R.clearRansomwareFlagCache();
  await putS3Object({ orgId: ORG, bucket: "docs", key: "a/keep.txt", bodyBuffer: Buffer.from("keep"), actorEmail: "admin" });
  // rewriting a tripwire is CRITICAL on its own -> the actor is contained
  const r = await R.noteActivity({ orgId: ORG, actorKey: actor, kind: "overwrite", bucket: "docs", key: `${R.CANARY_PREFIX}do-not-touch-x.txt` });
  assert.equal(r.level, "CRITICAL");
});
after(async () => {
  const { db } = await getOrgCollections();
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) await db.collection(name).deleteMany({ $or: [{ orgId }, { orgId: ORG }, { ownerId: ORG }] }).catch(() => {});
  await db.collection("orgs").deleteOne({ _id: orgId });
  await (await mongoClientPromise).close();
});

const refused = async (p) => { await assert.rejects(p, (e) => e.reason === "Contained"); };
test("a paused credential cannot delete an object, a folder or complete a multipart upload", async () => {
  await refused(deleteS3Object({ orgId: ORG, bucket: "docs", key: "a/keep.txt", actorEmail: actor }));
  await refused(deleteS3Folder({ orgId: ORG, bucket: "docs", folderPath: "a/", actorEmail: actor }));
  await refused(completeMultipartUpload({ orgId: ORG, uploadId: "none", actorEmail: actor }));
  const ok = await deleteS3Object({ orgId: ORG, bucket: "docs", key: "a/keep.txt", actorEmail: "admin" });
  assert.ok(ok, "another credential is not affected");
});

test("the S3 and Azure routes pass the caller to every delete and to multipart completion", () => {
  const files = ["src/app/api/s3/[bucket]/[...key]/route.js", "src/app/api/s3/[bucket]/route.js", "src/app/api/azure/[container]/[...blob]/route.js"];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const call of src.match(/(deleteS3Object|deleteS3Folder|completeMultipartUpload|deleteObjectTagging)\(\{[^}]*\}/g) || []) {
      assert.match(call, /actorEmail: accessKeyId/, `${f}: ${call.slice(0, 80)}`);
    }
  }
});

test("rollback restores the pre-attack content (real store): overwrites and deletes come back, files the attacker created are not 'restorable'", async () => {
  process.env.S3_DEFAULT_VERSIONING = "on"; process.env.S3_DEFAULT_TRIPWIRE = "off";
  const bucket = `rb-${randomBytes(3).toString("hex")}`; const thief = `AKIAROLL${Date.now().toString(36)}`.toUpperCase();
  const original = Buffer.from("original management accounts"); const gone = Buffer.from("board minutes");
  await putS3Object({ orgId: ORG, bucket, key: "finance/q3.csv", bodyBuffer: original, actorEmail: "admin" });
  await putS3Object({ orgId: ORG, bucket, key: "board/minutes.md", bodyBuffer: gone, actorEmail: "admin" });
  await new Promise((r) => setTimeout(r, 50));
  await putS3Object({ orgId: ORG, bucket, key: "finance/q3.csv", bodyBuffer: randomBytes(4096), actorEmail: thief });
  await putS3Object({ orgId: ORG, bucket, key: "finance/q3.csv.locked", bodyBuffer: randomBytes(512), actorEmail: thief });
  await deleteS3Object({ orgId: ORG, bucket, key: "board/minutes.md", actorEmail: thief });
  const owner = { role: "owner", email: "owner@example.com" };
  const plan = await R.rollbackPreview({ orgId: ORG, membership: owner, actorKey: thief, sinceIso: new Date(Date.now() - 3600_000).toISOString() });
  const row = (k) => plan.objects.find((o) => o.key === k);
  assert.ok(row("finance/q3.csv").restorableVersionId, "the overwritten file has a version from before the attack");
  assert.equal(row("finance/q3.csv.locked").restorableVersionId, null, "a file the attacker created has nothing earlier to restore");
  assert.ok(row("board/minutes.md").restorableVersionId, "the deleted file can be brought back");
  const done = await R.rollbackExecute({ orgId: ORG, membership: owner, actorEmail: owner.email, items: plan.objects.filter((o) => o.restorableVersionId).map((o) => ({ bucket, key: o.key, versionId: o.restorableVersionId })) });
  assert.equal(done.restored, 2); assert.deepEqual(done.failed, []);
  assert.equal((await getS3ObjectBody({ orgId: ORG, bucket, key: "finance/q3.csv" })).buffer.toString(), original.toString(), "the original bytes are back");
  assert.equal((await getS3ObjectBody({ orgId: ORG, bucket, key: "board/minutes.md" })).buffer.toString(), gone.toString(), "the deleted file is back");
});
