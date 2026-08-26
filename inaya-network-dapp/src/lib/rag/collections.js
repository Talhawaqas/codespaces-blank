// src/lib/rag/collections.js
//
// Shared MongoDB collection access for the RAG infrastructure — not
// org-scoped (unlike orgs.js), lives in the same `inaya_network_corporate`
// Atlas database as everything else. Kept as its own small file (rather
// than folded into orgs.js) since RAG is a cross-cutting layer under all
// three of Docs/Security/Learn, not part of the Business Workspace domain
// model orgs.js owns.

import { connectToDatabase } from "../mongodb.js";

export async function getRagCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    ragChunks: db.collection("rag_chunks"),
    ragSources: db.collection("rag_sources"),
    ragIngestionRuns: db.collection("rag_ingestion_runs"),
    ragQueryLog: db.collection("rag_query_log"),
    ragEmbeddingCache: db.collection("rag_embedding_cache"),
  };
}

let plainIndexesEnsured = false;

/** Plain (non-search) indexes only — the vectorSearch/search indexes on
 *  rag_chunks are created separately by vectorStore.js's ensureIndexes(),
 *  since those use collection.createSearchIndex() (a different API, and
 *  slower to build) rather than collection.createIndex(). Kept as two
 *  separate functions so a route that only needs plain lookups (e.g. the
 *  admin stats route) doesn't have to wait on search-index creation. */
export async function ensureRagPlainIndexes() {
  if (plainIndexesEnsured) return;
  const { ragChunks, ragSources, ragIngestionRuns, ragQueryLog, ragEmbeddingCache } = await getRagCollections();

  await Promise.all([
    ragChunks.createIndex({ domain: 1, sourceId: 1 }),
    ragChunks.createIndex({ sourceId: 1, section: 1 }),
    ragChunks.createIndex({ videoId: 1 }),
    ragSources.createIndex({ sourceId: 1 }, { unique: true }),
    ragIngestionRuns.createIndex({ sourceId: 1, startedAt: 1 }),
    ragQueryLog.createIndex({ domain: 1, timestamp: 1 }),
    ragQueryLog.createIndex({ resultCount: 1, timestamp: 1 }),
    ragEmbeddingCache.createIndex({ contentHash: 1 }, { unique: true }),
  ]);

  plainIndexesEnsured = true;
}
