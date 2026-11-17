// test/s3-chunked-format.test.mjs -- S3-compatible storage (and NAS, Azure/GCS, bookkeeping, support attachments and
// document automation, which all write through putS3Object) stores objects in the chunked format since 17 Nov 2026:
// about 1 byte per byte instead of the original format's 1.78. Runs against the test database with an in-memory
// bucket standing in for Filebase (chunkedStorage.setChunkedObjectBackendForTests).
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, getS3ObjectBody, deleteS3Object } from "../src/lib/s3-compat/store.js";
import { putS3ObjectWithFallback } from "../src/lib/s3-compat/putWithFallback.js";
import { clearObjectBodyCache } from "../src/lib/s3-compat/objectBodyCache.js";
import { setChunkedObjectBackendForTests } from "../src/lib/chunkedStorage.js";
import clientPromise from "../src/lib/mongodb.js";

if (!process.env.INTEGRATION_ENCRYPTION_KEY) process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// In-memory bucket: key -> bytes. `failPuts` makes every write fail, to exercise the fallback.
const bucketStore = new Map();
let failPuts = false; let cidN = 0;
const memory = {
  put: async (key, bytes) => { if (failPuts) throw new Error("bucket unavailable"); bucketStore.set(key, new Uint8Array(bytes)); return `bafy-test-${++cidN}`; },
  get: async (key) => { if (!bucketStore.has(key)) throw new Error(`missing ${key}`); return bucketStore.get(key); },
  deletePrefix: async (prefix) => { let deleted = 0; for (const k of [...bucketStore.keys()]) if (k.startsWith(prefix)) { bucketStore.delete(k); deleted++; } return { deleted }; },
};
const storedUnder = (prefix) => [...bucketStore.entries()].filter(([k]) => k.startsWith(prefix));

const RUN = randomBytes(3).toString("hex"); let orgId; let orgOid; const bucket = `chunked-${RUN}`;
before(async () => {
  setChunkedObjectBackendForTests(memory);
  await ensureOrgIndexes(); const c = await getOrgCollections();
  orgOid = (await c.orgs.insertOne({ name: `s3-chunked-${RUN}`, createdAt: new Date().toISOString() })).insertedId; orgId = String(orgOid);
  await ensureOwnerS3Passphrase({ type: "org", orgId });
});
beforeEach(() => { failPuts = false; clearObjectBodyCache(); });
after(async () => {
  setChunkedObjectBackendForTests(null);
  try {
    const c = await getOrgCollections(); const names = (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name);
    for (const n of names) { try { await c.db.collection(n).deleteMany({ orgId: orgOid }); } catch { /* ignore */ } }
    await c.db.collection("s3_owner_keys").deleteMany({ ownerId: orgId }); await c.orgs.deleteMany({ _id: orgOid });
  } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

test("an object is stored chunked at about 1 byte per byte and reads back byte-for-byte", { timeout: 120000 }, async () => {
  for (const size of [1, 5000, 2 * 1024 * 1024 + 3]) {
    const body = randomBytes(size);
    const doc = await putS3Object({ orgId, bucket, key: `docs/file-${size}.bin`, bodyBuffer: body, contentType: "application/pdf", actorEmail: "sqa" });
    assert.ok(doc.storage?.prefix, "the record points at its pieces");
    assert.equal(doc.pinProvider, "filebase");
    const pieceBytes = storedUnder(doc.storage.prefix).filter(([k]) => !k.endsWith(".json")).reduce((n, [, v]) => n + v.length, 0);
    assert.ok(pieceBytes <= size + 64, `size ${size}: stored ${pieceBytes} bytes of pieces`);
    const back = await getS3ObjectBody({ orgId, bucket, key: `docs/file-${size}.bin` });
    assert.equal(Buffer.compare(back.buffer, body), 0, `size ${size} reads back intact`);
  }
});

test("NAS, bookkeeping and other stores (putS3ObjectWithFallback, Filebase first) also get the chunked format", { timeout: 60000 }, async () => {
  const body = randomBytes(30000);
  const { obj } = await putS3ObjectWithFallback({ orgId, bucket, key: "nas/backup.bin", bodyBuffer: body, contentType: "application/octet-stream", actorEmail: "nas" });
  assert.ok(obj.storage?.prefix);
  assert.equal(Buffer.compare((await getS3ObjectBody({ orgId, bucket, key: "nas/backup.bin" })).buffer, body), 0);
});

test("if the bucket can't take the write, the object is stored in the original format and still reads back", { timeout: 60000 }, async () => {
  failPuts = true;
  const body = randomBytes(4000);
  const doc = await putS3Object({ orgId, bucket, key: "fallback.bin", bodyBuffer: body, actorEmail: "sqa" });
  assert.equal(doc.storage, undefined, "original format");
  assert.ok(doc.cidAlpha && doc.cidBeta);
  assert.equal(storedUnder(`ws/${orgId}/`).filter(([k]) => k.includes("fallback")).length, 0);
  failPuts = false;
  assert.equal(Buffer.compare((await getS3ObjectBody({ orgId, bucket, key: "fallback.bin" })).buffer, body), 0);
});

test("an empty object (a folder marker) keeps the original format", async () => {
  const doc = await putS3Object({ orgId, bucket, key: "folder/", bodyBuffer: Buffer.alloc(0), actorEmail: "sqa" });
  assert.equal(doc.storage, undefined);
  assert.equal((await getS3ObjectBody({ orgId, bucket, key: "folder/" })).buffer.length, 0);
});

test("overwriting or deleting a chunked object removes its pieces from the bucket", { timeout: 60000 }, async () => {
  const first = await putS3Object({ orgId, bucket, key: "overwrite.bin", bodyBuffer: randomBytes(1000), actorEmail: "sqa" });
  assert.ok(storedUnder(first.storage.prefix).length >= 4);
  const second = await putS3Object({ orgId, bucket, key: "overwrite.bin", bodyBuffer: randomBytes(1000), actorEmail: "sqa" });
  assert.equal(storedUnder(first.storage.prefix).length, 0, "the replaced version's pieces are purged");
  await deleteS3Object({ orgId, bucket, key: "overwrite.bin", actorEmail: "sqa" });
  assert.equal(storedUnder(second.storage.prefix).length, 0, "a deleted object's pieces are purged");
});

const live = process.env.FILEBASE_ACCESS_KEY && process.env.FILEBASE_SECRET_KEY && process.env.FILEBASE_BUCKET;
test("real Filebase: an S3 object is stored chunked, read back, and fully removed on delete", { skip: !live && "Filebase is not configured", timeout: 300000 }, async () => {
  // Opt-in use of the real bucket (pinningProviders/testGuard.js); the delete below purges every piece.
  const prior = process.env.INAYA_TESTS_USE_REAL_STORAGE;
  process.env.INAYA_TESTS_USE_REAL_STORAGE = "1";
  setChunkedObjectBackendForTests(null);
  const { deleteStoredPrefix } = await import("../src/lib/chunkedStorage.js");
  let prefix = null;
  try {
    const body = randomBytes(150 * 1024 + 17);
    const doc = await putS3Object({ orgId, bucket, key: "live/object.bin", bodyBuffer: body, contentType: "application/octet-stream", actorEmail: "sqa" });
    prefix = doc.storage?.prefix;
    assert.ok(prefix, "stored in the chunked format on the real bucket");
    assert.match(doc.cidAlpha, /^(baf|Qm)/, "Filebase returned a real IPFS CID for the manifest");
    clearObjectBodyCache();
    assert.equal(Buffer.compare((await getS3ObjectBody({ orgId, bucket, key: "live/object.bin" })).buffer, body), 0, "reads back byte-for-byte");
    await deleteS3Object({ orgId, bucket, key: "live/object.bin", actorEmail: "sqa" });
    assert.equal((await deleteStoredPrefix(prefix)).deleted, 0, "the delete already removed every piece");
  } finally {
    if (prefix) await deleteStoredPrefix(prefix).catch(() => {});
    setChunkedObjectBackendForTests(memory);
    if (prior === undefined) delete process.env.INAYA_TESTS_USE_REAL_STORAGE; else process.env.INAYA_TESTS_USE_REAL_STORAGE = prior;
  }
});
