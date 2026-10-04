// test/s3-null-version.test.mjs -- regression found by running real Terraform: after an object in an UNVERSIONED bucket is overwritten, a read of
// ?versionId=null (which the AWS provider issues after every update) returned the replaced copy, whose storage had already been purged, so every
// read failed with a 500 and Terraform retried forever. "null" must resolve to the live object only. Real MongoDB.
// Run: node --env-file=.env.local --test --test-force-exit test/s3-null-version.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { putS3Object, getS3ObjectBody, headS3Object, deleteS3Object, putBucketVersioning } from "../src/lib/s3-compat/store.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";

const RUN = randomUUID().slice(0, 8);
let c, orgId;
const A = () => ({ orgId: String(orgId) });
before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections();
  orgId = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: `null-version-${RUN}`, createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
});
after(async () => {
  await purgeOrgObjects(orgId).catch(() => {});
  await Promise.all([c.orgs.deleteMany({ _id: orgId }), c.departments.deleteMany({ orgId }), c.projects.deleteMany({ orgId }), c.orgDocuments.deleteMany({ orgId }), c.orgActivity.deleteMany({ orgId }), c.db.collection("s3_namespace").deleteMany({ scope: String(orgId) })]);
  await (await mongoClientPromise).close();
});
const put = (bucket, key, text) => putS3Object({ ...A(), bucket, key, bodyBuffer: Buffer.from(text), contentType: "text/plain", actorEmail: "t@example.com" });
const body = async (bucket, key, versionId) => (await getS3ObjectBody({ ...A(), bucket, key, versionId }))?.buffer?.toString();

test("unversioned bucket: after an overwrite, versionId=null reads the NEW content (not the replaced copy)", async () => {
  const bucket = `nv-${RUN}`;
  await put(bucket, "config/greeting.txt", "version one");
  assert.equal(await body(bucket, "config/greeting.txt", "null"), "version one");
  await put(bucket, "config/greeting.txt", "version two, longer");
  assert.equal(await body(bucket, "config/greeting.txt", "null"), "version two, longer", "explicit null resolves to the live object");
  assert.equal(await body(bucket, "config/greeting.txt"), "version two, longer", "and so does a plain read");
  await put(bucket, "config/greeting.txt", "version three");
  assert.equal(await body(bucket, "config/greeting.txt", "null"), "version three", "still correct after a second overwrite");
  assert.equal((await headS3Object({ ...A(), bucket, key: "config/greeting.txt", versionId: "null" })).sizeBytes, "version three".length);
});

test("unversioned bucket: after a delete, versionId=null is NoSuchKey, not a purged leftover", async () => {
  const bucket = `nv-del-${RUN}`;
  await put(bucket, "k.txt", "one"); await put(bucket, "k.txt", "two");
  await deleteS3Object({ ...A(), bucket, key: "k.txt", actorEmail: "t@example.com" });
  assert.equal(await headS3Object({ ...A(), bucket, key: "k.txt", versionId: "null" }), null);
  assert.equal(await headS3Object({ ...A(), bucket, key: "k.txt" }), null);
});

test("versioned bucket: explicit version ids still return exactly that version, old ones included", async () => {
  const bucket = `v-${RUN}`;
  await put(bucket, "k.txt", "seed"); // creates the bucket
  await putBucketVersioning({ ...A(), bucket, status: "Enabled" });
  const v1 = await put(bucket, "k.txt", "first"); const v2 = await put(bucket, "k.txt", "second");
  assert.equal(await body(bucket, "k.txt", v1.versionId), "first", "an older version is still retrievable by its id");
  assert.equal(await body(bucket, "k.txt", v2.versionId), "second");
  assert.equal(await body(bucket, "k.txt"), "second");
});
