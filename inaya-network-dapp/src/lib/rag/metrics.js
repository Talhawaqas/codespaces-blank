// src/lib/rag/metrics.js
//
// Append-only observability logs backing the /admin/rag dashboard — same
// "record what actually happened, never fabricate" discipline as every
// other monitoring surface in this codebase (ADMIN_DASHBOARD.md's
// honest-null convention). Never blocks the caller: a metrics-write
// failure is logged and swallowed, exactly like sendEmail/assessRisk/
// recordFaucetRequest's established fail-open pattern — observability
// must never be able to turn a successful retrieval into a failed one.

import { getRagCollections } from "./collections.js";

export async function recordRetrieval({ domain, query, resultCount, topScore, belowThreshold, latencyMs, cacheHit }) {
  try {
    const { ragQueryLog } = await getRagCollections();
    await ragQueryLog.insertOne({
      domain, queryTextTruncated: String(query || "").slice(0, 200),
      resultCount, topScore: topScore ?? null, belowThreshold: !!belowThreshold, latencyMs, cacheHit: !!cacheHit,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("rag/metrics: recordRetrieval failed (non-fatal):", err);
  }
}

export async function recordIngestionRun({ sourceId, startedAt, finishedAt, chunksAdded, chunksUpdated, chunksRemoved, error }) {
  try {
    const { ragIngestionRuns, ragSources } = await getRagCollections();
    await ragIngestionRuns.insertOne({
      sourceId, startedAt, finishedAt, chunksAdded, chunksUpdated, chunksRemoved,
      error: error ? String(error.message || error) : null,
    });
    if (!error) {
      await ragSources.updateOne(
        { sourceId },
        { $set: { sourceId, lastIngestedAt: finishedAt, chunkCount: chunksAdded + chunksUpdated } },
        { upsert: true }
      );
    }
  } catch (err) {
    console.error("rag/metrics: recordIngestionRun failed (non-fatal):", err);
  }
}
