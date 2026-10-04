// src/lib/s3-compat/namespaceClaim.js
//
// Race-free "create this bucket/container if it does not exist". The stores used to do findOne() then insertOne(); when several clients write
// their FIRST objects to a new bucket at the same moment (AzCopy and `aws s3 cp --recursive` both do), each saw "no bucket", each inserted one,
// and the objects ended up split across duplicate buckets, so a read straight after a successful write could 404 (found by running real AzCopy).
//
// claimId() returns ONE id per (scope, kind, parent, name), however many callers race: a unique index on s3_namespace plus an atomic upsert makes
// every caller receive the same id, and each then creates its document under that id with an upsert-by-_id, which is idempotent.

const indexed = new WeakSet();

async function ensureIndex(col) {
  if (indexed.has(col)) return;
  await col.createIndex({ scope: 1, kind: 1, parent: 1, name: 1 }, { unique: true });
  indexed.add(col);
}

/** `db` is the Mongo Db the bucket documents live in; `make()` produces a new id (ObjectId or string) used only if this caller wins. */
export async function claimId({ db, scope, kind, parent = null, name, make }) {
  const col = db.collection("s3_namespace");
  await ensureIndex(col);
  const key = { scope: String(scope), kind, parent: parent === null ? null : String(parent), name };
  const res = await col.findOneAndUpdate(key, { $setOnInsert: { claimId: make(), createdAt: new Date().toISOString() } }, { upsert: true, returnDocument: "after" });
  return (res?.value ?? res).claimId;
}

/** Forget a claim when its bucket is deleted, so a bucket created later with the same name starts with a clean identity. */
export async function releaseClaim({ db, scope, kind, parent = null, name }) {
  await db.collection("s3_namespace").deleteOne({ scope: String(scope), kind, parent: parent === null ? null : String(parent), name });
}
