// src/lib/rag/queryCache.js
//
// Short-TTL in-memory cache for retrieval results — same "safe by
// construction" property the rest of RAG's permission model has: since
// nothing private ever enters the vector store (see retrieve.js's header
// comment), a cached retrieval result can never leak one user's private
// data to another, so caching by query text alone (no per-user key) is
// safe. Same in-memory-per-instance caveat every other cache in this
// codebase (fraudRisk's riskCache, ai/chat's requestLog) already carries —
// a soft speed-up, not a distributed cache; fine for cutting repeated
// identical questions (a common FAQ phrasing) within one warm instance.

import { hashText } from "./chunking.js";

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map(); // key -> { value, cachedAt }

function cacheKey({ query, domain, sourceId }) {
  return hashText(`${domain || ""}::${sourceId || ""}::${query}`);
}

export function getCachedRetrieval(params) {
  const key = cacheKey(params);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedRetrieval(params, value) {
  const key = cacheKey(params);
  cache.set(key, { value, cachedAt: Date.now() });
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, entry] of cache.entries()) {
      if (now - entry.cachedAt > TTL_MS) cache.delete(k);
    }
  }
}
