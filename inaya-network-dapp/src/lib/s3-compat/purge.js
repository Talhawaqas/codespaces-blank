// Frees provider storage when an S3-compat object's bytes are permanently gone.
//
// Deleting an object only ever set `deletedAt`, so the encrypted shards stayed pinned at the
// provider forever and slowly exhausted the plan (this is what filled the Filebase bucket). A
// purge removes the shards from every provider and, if a provider is unreachable, marks the
// document `purgePending` so `sweepPendingPurges()` (run by the s3-lifecycle cron) retries.
//
// Only call this for versions that can never be read again: an unversioned delete or overwrite,
// or a DELETE with an explicit versionId. A versioned bucket's plain DELETE is a delete marker
// and must keep its bytes.

import { purgeAssetReplicas } from "../backupEngine.js";
import { getOrgCollections } from "../orgs.js";

function refsOf(doc) {
  const provider = doc.pinProvider;
  return [doc.cidAlpha, doc.cidBeta].filter(Boolean).map((providerRef) => ({ provider, providerRef })).filter((r) => r.provider);
}

/** Best-effort: never throws, so a provider outage can't fail the user's DELETE/PUT. */
export async function purgeObjectStorage(doc) {
  if (!doc?.fileHash || (!doc.cidAlpha && !doc.cidBeta)) return { skipped: true };
  try {
    const result = await purgeAssetReplicas(doc.fileHash, { extraRefs: refsOf(doc) });
    const { orgDocuments } = await getOrgCollections();
    await orgDocuments.updateOne(
      { _id: doc._id },
      result.failed === 0 ? { $set: { storagePurgedAt: new Date().toISOString() }, $unset: { purgePending: "" } } : { $set: { purgePending: true } }
    );
    return result;
  } catch (err) {
    console.error("s3-compat purgeObjectStorage failed (will be retried by the sweep):", err.message);
    try {
      const { orgDocuments } = await getOrgCollections();
      await orgDocuments.updateOne({ _id: doc._id }, { $set: { purgePending: true } });
    } catch { /* the sweep also finds soft-deleted docs that never got storagePurgedAt */ }
    return { failed: 1 };
  }
}

/** Retries purges that failed earlier. Bounded per run. */
export async function sweepPendingPurges({ limit = 50 } = {}) {
  const { orgDocuments } = await getOrgCollections();
  const docs = await orgDocuments.find({ purgePending: true }).limit(limit).toArray();
  let purged = 0;
  let stillPending = 0;
  for (const doc of docs) {
    const result = await purgeObjectStorage(doc);
    if (result.failed) stillPending += 1; else purged += 1;
  }
  return { scanned: docs.length, purged, stillPending };
}

/** Test/ops helper: purge every S3-compat object an organization still holds at the providers. */
export async function purgeOrgObjects(orgId) {
  const { orgDocuments } = await getOrgCollections();
  const docs = await orgDocuments.find({ orgId, cidAlpha: { $exists: true }, storagePurgedAt: { $exists: false } }).toArray();
  let purged = 0;
  for (const doc of docs) {
    const result = await purgeObjectStorage(doc);
    if (!result.failed) purged += 1;
  }
  return { scanned: docs.length, purged };
}
