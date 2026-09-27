// SQA-016/017/018/020 regression tests for the S3-compatibility store, against the real database and the real pinning providers.
//   017 a refusing provider (Pinata "plan usage limit") no longer fails every write: the next configured provider is used, and the object reads back
//   016 multipart parts are ordered by part number, not by the database
//   018 CompleteMultipartUpload is claimed once: parallel retries all get the SAME object, nothing is written twice, later parts are refused
//   020 concurrent reads of one immutable version share one fetch-and-decrypt, and a deleted object is refused even while cached
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, getS3ObjectBody, deleteS3Object, createMultipartUpload, uploadPart, completeMultipartUpload } from "../src/lib/s3-compat/store.js";
import { clearObjectBodyCache } from "../src/lib/s3-compat/objectBodyCache.js";
import { PROVIDERS, listAvailableProviders } from "../src/lib/pinningProviders/index.js";
import clientPromise from "../src/lib/mongodb.js";

if (!process.env.INTEGRATION_ENCRYPTION_KEY) process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const RUN = randomBytes(3).toString("hex"); let orgId; let orgOid; const bucket = `sqa-store-${RUN}`;
const originalProviders = { ...PROVIDERS };
const available = listAvailableProviders();
const enough = available.length >= 2; // fallback needs a second configured provider

async function setup() {
  await ensureOrgIndexes(); const c = await getOrgCollections();
  orgOid = (await c.orgs.insertOne({ name: `sqa-store-${RUN}`, createdAt: new Date().toISOString() })).insertedId; orgId = String(orgOid);
  await ensureOwnerS3Passphrase({ type: "org", orgId });
}
after(async () => {
  Object.assign(PROVIDERS, originalProviders);
  try {
    const c = await getOrgCollections(); const names = (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name);
    for (const n of names) { try { await c.db.collection(n).deleteMany({ orgId: orgOid }); } catch { /* ignore */ } }
    await c.db.collection("s3_owner_keys").deleteMany({ ownerId: orgId }); await c.orgs.deleteMany({ _id: orgOid });
    await c.db.collection("s3_multipart_uploads").deleteMany({ bucket });
  } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

test("017: a provider that refuses the pin does not fail the write; the object is pinned elsewhere and reads back intact", { skip: !enough && "needs two configured pinning providers", timeout: 180000 }, async () => {
  await setup();
  const primary = available.includes("pinata") ? "pinata" : available[0];
  let refused = 0;
  PROVIDERS[primary] = { ...originalProviders[primary], pin: async () => { refused++; throw new Error("pin failed (HTTP 403): Account blocked due to plan usage limit"); } };
  const body = randomBytes(20000);
  const doc = await putS3Object({ orgId, bucket, key: "fallback/object.bin", bodyBuffer: body, contentType: "application/octet-stream", actorEmail: "sqa" });
  assert.ok(refused >= 1, "the preferred provider was tried first");
  assert.notEqual(doc.pinProvider, primary, "the object was pinned through another provider");
  Object.assign(PROVIDERS, originalProviders);
  const back = await getS3ObjectBody({ orgId, bucket, key: "fallback/object.bin" });
  assert.ok(Buffer.compare(back.buffer, body) === 0, "byte-identical after the fallback pin");
});

test("017: when EVERY provider refuses, the write fails cleanly and leaves no object behind", { skip: !enough && "needs two configured pinning providers", timeout: 120000 }, async () => {
  for (const name of available) PROVIDERS[name] = { ...originalProviders[name], pin: async () => { throw new Error("all down"); } };
  await assert.rejects(() => putS3Object({ orgId, bucket, key: "fallback/never.bin", bodyBuffer: randomBytes(100), actorEmail: "sqa" }), /all down/);
  Object.assign(PROVIDERS, originalProviders);
  assert.equal(await getS3ObjectBody({ orgId, bucket, key: "fallback/never.bin" }), null, "nothing was recorded");
});

test("016/018: parts arrive out of order, Complete is retried in parallel: one object, correct byte order, the same answer for everyone", { timeout: 300000 }, async () => {
  const uploadId = await createMultipartUpload({ orgId, bucket, key: "multi/big.bin", contentType: "application/octet-stream", actorEmail: "sqa" });
  const p1 = randomBytes(30000), p2 = randomBytes(30000), p3 = randomBytes(12345);
  for (const [n, buf] of [[3, p3], [1, p1], [2, p2]]) assert.ok(await uploadPart({ orgId, uploadId, partNumber: n, bodyBuffer: buf }));
  const results = await Promise.all([1, 2, 3].map(() => completeMultipartUpload({ orgId, uploadId, actorEmail: "sqa" })));
  const ids = new Set(results.map((d) => String(d._id)));
  assert.equal(ids.size, 1, "every parallel Complete returned the same object");
  const c = await getOrgCollections();
  assert.equal(await c.orgDocuments.countDocuments({ orgId: orgOid, filename: "multi/big.bin", deletedAt: null }), 1, "written exactly once");
  const back = await getS3ObjectBody({ orgId, bucket, key: "multi/big.bin" });
  assert.ok(Buffer.compare(back.buffer, Buffer.concat([p1, p2, p3])) === 0, "parts concatenated in part-number order");
  const again = await completeMultipartUpload({ orgId, uploadId, actorEmail: "sqa" });
  assert.equal(String(again._id), [...ids][0], "a later retry still gets the answer");
  assert.equal(await uploadPart({ orgId, uploadId, partNumber: 4, bodyBuffer: randomBytes(10) }), null, "no parts once completed");
  assert.equal(await completeMultipartUpload({ orgId, uploadId: "000000000000000000000000", actorEmail: "sqa" }), null, "an unknown upload is NoSuchUpload");
  assert.equal(await completeMultipartUpload({ orgId: new ObjectId().toString(), uploadId, actorEmail: "sqa" }), null, "another organization cannot complete or read it");
});

test("018: a failed completion releases the claim so the client can retry", { timeout: 120000 }, async () => {
  const uploadId = await createMultipartUpload({ orgId, bucket, key: "multi/retry.bin", contentType: "application/octet-stream", actorEmail: "sqa" });
  await assert.rejects(() => completeMultipartUpload({ orgId, uploadId, actorEmail: "sqa" }), /zero parts/i);
  assert.ok(await uploadPart({ orgId, uploadId, partNumber: 1, bodyBuffer: randomBytes(500) }), "the upload is still open after the failure");
  assert.ok(await completeMultipartUpload({ orgId, uploadId, actorEmail: "sqa" }));
});

test("020: concurrent reads share one fetch, and a deleted object is refused even while cached", { timeout: 180000 }, async () => {
  const key = "cache/object.bin"; const body = randomBytes(40000);
  const doc = await putS3Object({ orgId, bucket, key, bodyBuffer: body, actorEmail: "sqa" });
  clearObjectBodyCache();
  let fetches = 0; const name = doc.pinProvider;
  PROVIDERS[name] = { ...originalProviders[name], fetchReplica: async (ref) => { fetches++; return originalProviders[name].fetchReplica(ref); } };
  const reads = await Promise.all(Array.from({ length: 5 }, () => getS3ObjectBody({ orgId, bucket, key })));
  assert.equal(fetches, 2, "five concurrent reads cost one fetch of each shard");
  assert.ok(reads.every((r) => Buffer.compare(r.buffer, body) === 0));
  await getS3ObjectBody({ orgId, bucket, key }); assert.equal(fetches, 2, "a repeat read is served from the short-lived cache");
  await deleteS3Object({ orgId, bucket, key, actorEmail: "sqa" });
  assert.equal(await getS3ObjectBody({ orgId, bucket, key }), null, "authorization is re-checked on every request: a deleted object is never served from the cache");
  Object.assign(PROVIDERS, originalProviders);
});
