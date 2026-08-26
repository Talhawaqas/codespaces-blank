// src/lib/rag/vectorStore.js
//
// The ONLY file that knows this is MongoDB Atlas specifically — every
// other RAG file talks to retrieve.js/ingest.js, not to Atlas directly.
// If Inaya ever needs to swap vector databases (SOW §4: "keep the
// architecture replaceable"), this is the one file to replace; its
// exported shape (ensureIndexes/upsertChunks/hybridSearch/deleteBySource)
// is the whole contract.
//
// Hybrid = two separate Atlas queries merged in application code via
// Reciprocal Rank Fusion (RRF), not a single native "hybrid" aggregation
// stage — deliberately, since $rankFusion's availability depends on the
// exact Atlas version, while $vectorSearch + $search have both been
// stable, documented Atlas features for a long time and work on any
// Atlas cluster tier that supports Vector Search at all. RRF is also the
// standard, well-understood technique for this — see e.g.
// https://www.mongodb.com/docs/atlas/atlas-vector-search/tutorials/reciprocal-rank-fusion/

import { getRagCollections } from "./collections.js";
import { EMBEDDING_DIMENSIONS } from "./embeddings.js";

const VECTOR_INDEX_NAME = "rag_vector_index";
const TEXT_INDEX_NAME = "rag_text_index";
const RRF_K = 60; // standard RRF constant — de-emphasizes rank differences beyond the top handful of results

let indexesEnsured = false;

/** Idempotent — safe to call on every cold start / ingestion run. Atlas
 *  rejects creating a search index whose name already exists; that
 *  specific failure is treated as success (index already there), any
 *  other failure is logged and re-thrown since it means indexing is
 *  genuinely broken, not just "already set up." Note: a newly created
 *  Atlas Search/Vector index takes a little time to finish building
 *  before it's queryable — the very first query right after first-ever
 *  setup can return zero hits even with real ingested data; this is
 *  expected and resolves itself within a couple of minutes. */
export async function ensureIndexes() {
  if (indexesEnsured) return;
  const { ragChunks } = await getRagCollections();

  const existing = await ragChunks.listSearchIndexes().toArray().catch(() => []);
  const existingNames = new Set(existing.map((idx) => idx.name));

  if (!existingNames.has(VECTOR_INDEX_NAME)) {
    try {
      await ragChunks.createSearchIndex({
        name: VECTOR_INDEX_NAME,
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
            { type: "filter", path: "domain" },
            { type: "filter", path: "sourceId" },
          ],
        },
      });
    } catch (err) {
      if (!/already exists|duplicate/i.test(err.message || "")) throw err;
    }
  }

  if (!existingNames.has(TEXT_INDEX_NAME)) {
    try {
      await ragChunks.createSearchIndex({
        name: TEXT_INDEX_NAME,
        definition: {
          mappings: { dynamic: false, fields: { text: { type: "string" }, title: { type: "string" } } },
        },
      });
    } catch (err) {
      if (!/already exists|duplicate/i.test(err.message || "")) throw err;
    }
  }

  indexesEnsured = true;
}

/** chunkKey is the caller-assigned stable identity (see ingest.js) — used
 *  directly as _id so re-ingesting unchanged content is a true no-op
 *  update, and changed content overwrites the same document rather than
 *  accumulating duplicates. */
export async function upsertChunks(chunks) {
  if (!chunks || chunks.length === 0) return { upserted: 0 };
  const { ragChunks } = await getRagCollections();
  const now = new Date().toISOString();

  const ops = chunks.map((chunk) => ({
    updateOne: {
      filter: { _id: chunk.chunkKey },
      update: {
        $set: {
          sourceId: chunk.sourceId, domain: chunk.domain, title: chunk.title, section: chunk.section,
          category: chunk.category, version: chunk.version, url: chunk.url, text: chunk.text,
          contentHash: chunk.contentHash, embedding: chunk.embedding, videoId: chunk.videoId || null,
          accessScope: "public", updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsert: true,
    },
  }));

  const result = await ragChunks.bulkWrite(ops, { ordered: false });
  return { upserted: (result.upsertedCount || 0) + (result.modifiedCount || 0) };
}

export async function deleteBySource(sourceId) {
  const { ragChunks } = await getRagCollections();
  const result = await ragChunks.deleteMany({ sourceId });
  return { deleted: result.deletedCount || 0 };
}

/** Deletes chunks belonging to sourceId whose _id isn't in keepChunkKeys —
 *  the "content that disappeared from the source" case (a section was
 *  removed/renamed since the last ingestion run). */
export async function deleteObsoleteChunks(sourceId, keepChunkKeys) {
  const { ragChunks } = await getRagCollections();
  const result = await ragChunks.deleteMany({ sourceId, _id: { $nin: keepChunkKeys } });
  return { deleted: result.deletedCount || 0 };
}

async function vectorSearch({ queryEmbedding, domain, sourceId, limit }) {
  const { ragChunks } = await getRagCollections();
  const filter = {};
  if (domain) filter.domain = { $eq: domain };
  if (sourceId) filter.sourceId = { $eq: sourceId };

  const pipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME, path: "embedding", queryVector: queryEmbedding,
        numCandidates: Math.max(limit * 15, 150), limit,
        ...(Object.keys(filter).length ? { filter } : {}),
      },
    },
    { $project: { sourceId: 1, domain: 1, title: 1, section: 1, category: 1, url: 1, text: 1, score: { $meta: "vectorSearchScore" } } },
  ];

  try {
    return await ragChunks.aggregate(pipeline).toArray();
  } catch (err) {
    console.error("rag/vectorStore: $vectorSearch failed (index may still be building):", err.message);
    return [];
  }
}

async function textSearch({ queryText, domain, sourceId, limit }) {
  const { ragChunks } = await getRagCollections();
  // Domain/source filtering is applied AFTER $search rather than via a
  // compound filter clause inside it — simpler and safer to get right at
  // this corpus's realistic scale (low hundreds of chunks total across
  // all three domains) than hand-rolling Atlas Search's compound operator
  // syntax; over-fetch generously before filtering so a real match in the
  // target domain is never lost to the pre-filter cap.
  const pipeline = [
    { $search: { index: TEXT_INDEX_NAME, text: { query: queryText, path: ["text", "title"] } } },
    { $limit: Math.max(limit * 10, 100) },
    { $project: { sourceId: 1, domain: 1, title: 1, section: 1, category: 1, url: 1, text: 1, score: { $meta: "searchScore" } } },
  ];

  try {
    const results = await ragChunks.aggregate(pipeline).toArray();
    return results
      .filter((r) => (!domain || r.domain === domain) && (!sourceId || r.sourceId === sourceId))
      .slice(0, limit);
  } catch (err) {
    console.error("rag/vectorStore: $search failed (index may still be building):", err.message);
    return [];
  }
}

/** Runs both searches in parallel and merges by Reciprocal Rank Fusion:
 *  rrfScore(doc) = sum over each ranked list containing it of 1/(RRF_K + rank).
 *  Returns chunks sorted by rrfScore desc, each annotated with
 *  `vectorScore` (raw cosine similarity, or null if it only matched via
 *  text search) — retrieve.js uses vectorScore specifically for the
 *  relevance-threshold decision, since it's on a meaningful 0-1 scale
 *  unlike Atlas Search's unbounded BM25-style score. */
export async function hybridSearch({ queryText, queryEmbedding, domain, sourceId, topK = 6 }) {
  const overfetch = Math.max(topK * 3, 20);
  const [vectorResults, textResults] = await Promise.all([
    queryEmbedding ? vectorSearch({ queryEmbedding, domain, sourceId, limit: overfetch }) : Promise.resolve([]),
    queryText ? textSearch({ queryText, domain, sourceId, limit: overfetch }) : Promise.resolve([]),
  ]);

  // Neither $vectorSearch nor $search results are projected with _id above,
  // so dedup across the two ranked lists on sourceId+section instead —
  // stable per chunk since both come from the same underlying documents.
  const merged = new Map();
  function dedupKey(doc) {
    return `${doc.sourceId}::${doc.section || ""}`;
  }

  vectorResults.forEach((doc, rank) => {
    const key = dedupKey(doc);
    const rrf = 1 / (RRF_K + rank + 1);
    merged.set(key, { ...doc, rrfScore: rrf, vectorScore: doc.score });
  });
  textResults.forEach((doc, rank) => {
    const key = dedupKey(doc);
    const rrf = 1 / (RRF_K + rank + 1);
    const existing = merged.get(key);
    if (existing) existing.rrfScore += rrf;
    else merged.set(key, { ...doc, rrfScore: rrf, vectorScore: null });
  });

  return [...merged.values()].sort((a, b) => b.rrfScore - a.rrfScore).slice(0, topK);
}
