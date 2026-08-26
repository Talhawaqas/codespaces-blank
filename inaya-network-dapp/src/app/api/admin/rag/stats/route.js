// app/api/admin/rag/stats/route.js
//
// GET /api/admin/rag/stats — the RAG monitoring dashboard's data source.
// Same auth guard + "honest null, never a fabricated 0" convention as
// every other /api/admin/* stats route (see ADMIN_DASHBOARD.md). Every
// number here is a real aggregation over rag_query_log/rag_ingestion_runs/
// rag_sources — nothing here is estimated or hardcoded.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { getRagCollections, ensureRagPlainIndexes } from "../../../../../lib/rag/collections.js";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // last 7 days

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    await ensureRagPlainIndexes();
    const { ragQueryLog, ragIngestionRuns, ragSources, ragChunks } = await getRagCollections();
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();

    const recentQueries = await ragQueryLog.find({ timestamp: { $gte: sinceIso } }).toArray();

    const byDomain = {};
    for (const q of recentQueries) {
      const d = q.domain || "unknown";
      byDomain[d] = byDomain[d] || { total: 0, withResults: 0, noResults: 0, belowThreshold: 0, latencies: [] };
      byDomain[d].total += 1;
      byDomain[d].latencies.push(q.latencyMs || 0);
      if (q.resultCount > 0 && !q.belowThreshold) byDomain[d].withResults += 1;
      else if (q.belowThreshold) byDomain[d].belowThreshold += 1;
      else byDomain[d].noResults += 1;
    }

    function percentile(sortedArr, p) {
      if (sortedArr.length === 0) return null;
      const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
      return sortedArr[idx];
    }

    const domainStats = Object.entries(byDomain).map(([domain, stats]) => {
      const sorted = [...stats.latencies].sort((a, b) => a - b);
      return {
        domain,
        totalQueries: stats.total,
        successRate: stats.total > 0 ? Math.round((stats.withResults / stats.total) * 1000) / 10 : null,
        noResultCount: stats.noResults,
        belowThresholdCount: stats.belowThreshold,
        avgLatencyMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
        p95LatencyMs: percentile(sorted, 95),
      };
    });

    // Frequently unanswered questions — the actual "gap in the docs"
    // signal the SOW asks for: group truncated query text among no-
    // result/below-threshold entries, most frequent first.
    const unanswered = recentQueries.filter((q) => q.resultCount === 0 || q.belowThreshold);
    const unansweredCounts = new Map();
    for (const q of unanswered) {
      const key = q.queryTextTruncated;
      unansweredCounts.set(key, (unansweredCounts.get(key) || 0) + 1);
    }
    const frequentlyUnanswered = [...unansweredCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([query, count]) => ({ query, count }));

    const recentRuns = await ragIngestionRuns.find({}).sort({ startedAt: -1 }).limit(50).toArray();
    const indexingFailures = recentRuns.filter((r) => r.error).map((r) => ({ sourceId: r.sourceId, startedAt: r.startedAt, error: r.error }));

    const sources = await ragSources.find({}).sort({ sourceId: 1 }).toArray();
    const freshness = sources.map((s) => ({ sourceId: s.sourceId, lastIngestedAt: s.lastIngestedAt || null, chunkCount: s.chunkCount ?? null }));

    const totalChunks = await ragChunks.countDocuments({});
    const chunksByDomain = await ragChunks.aggregate([{ $group: { _id: "$domain", count: { $sum: 1 } } }]).toArray();

    return NextResponse.json({
      windowDays: 7,
      totalChunks,
      chunksByDomain: Object.fromEntries(chunksByDomain.map((d) => [d._id, d.count])),
      domainStats,
      frequentlyUnanswered,
      indexingFailures,
      sourceFreshness: freshness,
    });
  } catch (err) {
    console.error("admin/rag/stats failed:", err);
    return NextResponse.json({ error: "Could not load RAG stats." }, { status: 500 });
  }
}
