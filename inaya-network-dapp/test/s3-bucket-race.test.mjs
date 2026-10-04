// test/s3-bucket-race.test.mjs -- regression for a race found by running real AzCopy: several clients writing their FIRST objects to a new
// bucket at once each created their own bucket (find-then-insert), splitting the objects across duplicates so a read right after a successful
// write could 404. Now every concurrent caller gets the same bucket. Real MongoDB, org side and wallet side.
// Run: node --env-file=.env.local --test --test-force-exit test/s3-bucket-race.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { connectToDatabase } from "../src/lib/mongodb.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { ensureS3Bucket, listS3Buckets, deleteS3Bucket, putS3Object, getS3ObjectBody } from "../src/lib/s3-compat/store.js";
import * as wallet from "../src/lib/s3-compat/walletStore.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";

const RUN = randomUUID().slice(0, 8);
let c, orgId; const wallets = [];
before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections();
  orgId = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: `bucket-race-${RUN}`, createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
});
after(async () => {
  await purgeOrgObjects(orgId).catch(() => {});
  await Promise.all([c.orgs.deleteMany({ _id: orgId }), c.departments.deleteMany({ orgId }), c.projects.deleteMany({ orgId }), c.orgDocuments.deleteMany({ orgId }), c.orgActivity.deleteMany({ orgId }),
    c.db.collection("s3_namespace").deleteMany({ scope: String(orgId) })]);
  const { db } = await connectToDatabase();
  for (const w of wallets) { await db.collection("metadata_folders").deleteMany({ owner: w }); await db.collection("s3_namespace").deleteMany({ scope: w }); }
  await (await mongoClientPromise).close();
});

test("org: 12 concurrent first writes to a new bucket create exactly one bucket and one system department", async () => {
  const bucket = `race-${RUN}`;
  const docs = await Promise.all(Array.from({ length: 12 }, () => ensureS3Bucket({ orgId: String(orgId), bucket, actorEmail: "t@example.com" })));
  assert.equal(new Set(docs.map((d) => String(d._id))).size, 1, "every caller got the same bucket");
  assert.equal(await c.projects.countDocuments({ orgId, name: bucket }), 1);
  assert.equal(await c.departments.countDocuments({ orgId, isSystem: true }), 1, "one hidden system department, not one per racer");
  assert.deepEqual((await listS3Buckets(String(orgId))).map((b) => b.name), [bucket]);
});

test("org: objects written concurrently into a brand-new bucket are all readable afterwards", async () => {
  const bucket = `race-objs-${RUN}`;
  const keys = ["a.txt", "b/c.txt", "d.bin"];
  await Promise.all(keys.map((key) => putS3Object({ orgId: String(orgId), bucket, key, bodyBuffer: Buffer.from(`body of ${key}`), contentType: "text/plain", actorEmail: "t@example.com" })));
  assert.equal(await c.projects.countDocuments({ orgId, name: bucket }), 1, "still one bucket");
  for (const key of keys) {
    const got = await getS3ObjectBody({ orgId: String(orgId), bucket, key });
    assert.ok(got, `${key} is readable right after the writes returned`);
  }
});

test("org: deleting an empty bucket forgets its identity; recreating it works and is again a single bucket", async () => {
  const bucket = `race-del-${RUN}`;
  const first = await ensureS3Bucket({ orgId: String(orgId), bucket });
  assert.deepEqual(await deleteS3Bucket({ orgId: String(orgId), bucket }), { deleted: true });
  const again = await Promise.all([ensureS3Bucket({ orgId: String(orgId), bucket }), ensureS3Bucket({ orgId: String(orgId), bucket })]);
  assert.equal(String(again[0]._id), String(again[1]._id));
  assert.notEqual(String(again[0]._id), String(first._id), "a re-created bucket is a new bucket, not the old one resurrected");
});

test("wallet: concurrent first writes to a new bucket create exactly one bucket; delete then recreate works", async () => {
  const w = `0x${RUN}${"ab".repeat(16)}`.slice(0, 42).toLowerCase(); wallets.push(w);
  const bucket = `wrace-${RUN}`;
  const docs = await Promise.all(Array.from({ length: 12 }, () => wallet.ensureS3Bucket({ walletAddress: w, bucket })));
  assert.equal(new Set(docs.map((d) => d.folderId)).size, 1);
  const { db } = await connectToDatabase();
  assert.equal(await db.collection("metadata_folders").countDocuments({ owner: w, name: bucket, deletedAt: null }), 1);
  assert.deepEqual(await wallet.deleteS3Bucket({ walletAddress: w, bucket }), { deleted: true });
  const re = await wallet.ensureS3Bucket({ walletAddress: w, bucket });
  assert.notEqual(re.folderId, docs[0].folderId);
  assert.equal(re.deletedAt, null);
});
