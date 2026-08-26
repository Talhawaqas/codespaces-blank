// src/lib/rag/ingest.js
//
// The ingestion orchestrator every source adapter feeds into.
// Content-hash diffing means a re-run only pays for embedding calls on
// chunks that actually changed — never a full rebuild (SOW §10).
//
// Chunk identity: chunkKey = `${sourceId}::${index}`, the chunk's
// position in the array the adapter returns for that source. This is a
// deliberate, documented simplification (not content-addressed): if a
// source's structure changes so an earlier section is removed, every
// chunk AFTER it shifts position and gets re-embedded even though its
// text didn't change. Accepted trade-off — these are low-frequency,
// team-controlled content sources (docs/security), re-embedding an extra
// chunk occasionally costs a few cents, not a correctness problem; a
// content-addressed scheme would add real complexity for a benefit this
// app's actual update cadence doesn't need.

import { embedChunkText } from "./embeddings.js";
import { upsertChunks, deleteObsoleteChunks, deleteBySource as vectorStoreDeleteBySource, ensureIndexes } from "./vectorStore.js";
import { recordIngestionRun } from "./metrics.js";
import { getRagCollections } from "./collections.js";

/** adapter is a (possibly async) function returning an array of raw chunk
 *  objects (chunking.js's shape, no embedding/chunkKey yet) for one
 *  sourceId. Returns {sourceId, chunksAdded, chunksUpdated, chunksRemoved, chunksUnchanged}. */
export async function ingestSource({ sourceId, domain, adapter }) {
  const startedAt = new Date().toISOString();
  try {
    await ensureIndexes();

    const rawChunks = await adapter();
    const withKeys = rawChunks.map((chunk, index) => ({ ...chunk, chunkKey: `${sourceId}::${index}` }));

    const { ragChunks } = await getRagCollections();
    const existing = await ragChunks.find({ sourceId }, { projection: { _id: 1, contentHash: 1 } }).toArray();
    const existingByKey = new Map(existing.map((doc) => [doc._id, doc.contentHash]));

    const toEmbed = withKeys.filter((chunk) => existingByKey.get(chunk.chunkKey) !== chunk.contentHash);
    const unchangedCount = withKeys.length - toEmbed.length;

    const embedded = [];
    for (const chunk of toEmbed) {
      const embedding = await embedChunkText(chunk.text);
      if (embedding) embedded.push({ ...chunk, embedding, domain });
      else console.error(`rag/ingest: skipped chunk ${chunk.chunkKey} — embedding failed.`);
    }

    const { upserted } = await upsertChunks(embedded);
    const chunksAdded = embedded.filter((c) => !existingByKey.has(c.chunkKey)).length;
    const chunksUpdated = upserted - chunksAdded;

    const keepKeys = withKeys.map((c) => c.chunkKey);
    const { deleted } = await deleteObsoleteChunks(sourceId, keepKeys);

    const finishedAt = new Date().toISOString();
    await recordIngestionRun({ sourceId, startedAt, finishedAt, chunksAdded, chunksUpdated, chunksRemoved: deleted });

    return { sourceId, chunksAdded, chunksUpdated, chunksRemoved: deleted, chunksUnchanged: unchangedCount };
  } catch (err) {
    console.error(`rag/ingest: ingestion failed for source ${sourceId}:`, err);
    await recordIngestionRun({ sourceId, startedAt, finishedAt: new Date().toISOString(), chunksAdded: 0, chunksUpdated: 0, chunksRemoved: 0, error: err });
    return { sourceId, error: err.message };
  }
}

export async function ingestAllStaticSources() {
  // Deferred import to avoid a require cycle at module-eval time (sources
  // import from chunking.js, not from ingest.js).
  const { DOCS_SOURCES } = await import("./sources/docsSources.js");
  const { SECURITY_SOURCES } = await import("./sources/securitySources.js");
  const { LEARN_STATIC_SOURCES } = await import("./sources/learnSources.js");

  const allSources = [...DOCS_SOURCES, ...SECURITY_SOURCES, ...LEARN_STATIC_SOURCES];
  const results = [];
  for (const source of allSources) {
    results.push(await ingestSource(source));
  }
  return results;
}

export async function deleteSource(sourceId) {
  return vectorStoreDeleteBySource(sourceId);
}
