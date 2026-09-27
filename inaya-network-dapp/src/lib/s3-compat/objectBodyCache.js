// src/lib/s3-compat/objectBodyCache.js
//
// SQA-020 (S2): every ranged GET fetched BOTH encrypted shards from the pinning provider and decrypted the WHOLE object just to slice a range out of
// it. The AWS CLI (and every SDK's transfer manager) downloads a large object as several parallel ranged GETs, so a 30 MB object cost N full
// fetch-and-decrypt passes at once (35 to 60 seconds each, about the clients' 60 second read timeout) and the download failed.
//
// Concurrent and repeated reads of the SAME immutable object version now share ONE fetch-and-decrypt (single flight) and its result is kept briefly.
// Safety: the key is the immutable version's document id and callers still perform their own database lookup (existence, deletion, retention,
// scope) BEFORE asking for bytes, so a request that is no longer allowed never reaches the cache. Failures are never cached. Bounded in memory
// (per object and in total) and short-lived, because a serverless instance is a poor place to hold data.

const TTL_MS = 60 * 1000;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const entries = new Map(); // key -> { promise, at, size }

function evict(now = Date.now()) {
  let total = 0;
  for (const [k, e] of entries) { if (now - e.at > TTL_MS) entries.delete(k); else total += e.size || 0; }
  for (const [k, e] of [...entries].sort((a, b) => a[1].at - b[1].at)) { if (total <= MAX_TOTAL_BYTES) break; entries.delete(k); total -= e.size || 0; }
}

/** loader() must return { buffer, ...rest }. Concurrent callers with the same key await the same loader call. */
export async function cachedObjectBody(key, loader) {
  const now = Date.now(); evict(now);
  const hit = entries.get(key);
  if (hit) return hit.promise;
  const entry = { at: now, size: 0, promise: null };
  entry.promise = loader().then((value) => {
    entry.size = value?.buffer?.length || 0;
    if (entry.size > MAX_OBJECT_BYTES) entries.delete(key); // too large to keep, but the concurrent callers already share this result
    return value;
  }, (err) => { entries.delete(key); throw err; });
  entries.set(key, entry);
  return entry.promise;
}

export function clearObjectBodyCache() { entries.clear(); }
