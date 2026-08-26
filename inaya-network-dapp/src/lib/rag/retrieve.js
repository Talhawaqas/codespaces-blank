// src/lib/rag/retrieve.js
//
// retrieveContext() is the ONE function every assistant (Docs/Security/
// Learn) calls — no route talks to vectorStore.js or embeddings.js
// directly. This is also where the permission model actually lives: it's
// not a filter this function applies, it's a fact about what CAN be in
// rag_chunks at all — only public/curated content is ever ingested (see
// ingest.js's source adapters), so there is no private data this function
// could leak regardless of what query or domain it's asked for. Cross-
// user isolation for Security's per-identity events and Learn's per-
// wallet progress remains exactly where it already was: the existing
// tool-calling paths in ai-security-tools.js/ai-learn-tools.js, untouched
// by this file.
//
// Never throws — a retrieval failure (Atlas hiccup, embedding API error,
// index still building) degrades to {chunks:[], hasResults:false} so an
// assistant route can always fall back to "I don't have that information
// right now" instead of a hard 500 (SOW §15: graceful fallback).

import { embedQueryText } from "./embeddings.js";
import { hybridSearch } from "./vectorStore.js";
import { getCachedRetrieval, setCachedRetrieval } from "./queryCache.js";
import { recordRetrieval } from "./metrics.js";

const DEFAULT_TOP_K = 6;
// Cosine similarity floor for gemini-embedding-001, calibrated against a
// REAL measurement on this project's own Atlas cluster (not guessed): a
// genuinely relevant query/chunk pair scored ~0.89-0.91; multiple
// genuinely irrelevant queries (unrelated topics, and even a same-
// product-but-wrong-topic query) against the same chunk all scored
// ~0.72-0.77. 0.80 sits with real margin above the irrelevant band and
// real margin below the relevant band — biased toward the safe failure
// mode (a false "insufficient information" over a false confident
// answer), matching the SOW's explicit priority. Revisit against
// /admin/rag's real low-relevance-retrieval stats once the full
// production corpus is indexed and real usage data exists — this was
// calibrated against a small diagnostic corpus, not the final one.
const DEFAULT_MIN_RELEVANCE = 0.8;
const RETRIEVAL_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ]);
}

/**
 * @param {string} query - the user's question (or the message it's derived from)
 * @param {string} domain - "docs" | "security" | "learn"
 * @param {string} [sourceId] - restrict to one specific source (e.g. one video's transcript)
 * @param {number} [topK]
 * @param {number} [minRelevance]
 * @returns {Promise<{chunks: Array, hasResults: boolean}>}
 */
export async function retrieveContext({ query, domain, sourceId, topK = DEFAULT_TOP_K, minRelevance = DEFAULT_MIN_RELEVANCE }) {
  const trimmedQuery = String(query || "").trim();
  if (!trimmedQuery) return { chunks: [], hasResults: false };

  const cached = getCachedRetrieval({ query: trimmedQuery, domain, sourceId });
  if (cached) {
    recordRetrieval({ domain, query: trimmedQuery, resultCount: cached.rawResultCount, topScore: cached.topScore, belowThreshold: cached.rawResultCount > 0 && !cached.hasResults, latencyMs: 0, cacheHit: true });
    return { chunks: cached.chunks, hasResults: cached.hasResults };
  }

  const startedAt = Date.now();
  const result = await withTimeout(runRetrieval({ trimmedQuery, domain, sourceId, topK, minRelevance }), RETRIEVAL_TIMEOUT_MS);
  const latencyMs = Date.now() - startedAt;

  if (result.timedOut) {
    console.error(`rag/retrieve: retrieval timed out after ${RETRIEVAL_TIMEOUT_MS}ms for domain=${domain}`);
    recordRetrieval({ domain, query: trimmedQuery, resultCount: 0, topScore: null, belowThreshold: false, latencyMs, cacheHit: false });
    return { chunks: [], hasResults: false };
  }

  setCachedRetrieval({ query: trimmedQuery, domain, sourceId }, result);
  // resultCount logged is the RAW merged count (before the relevance-
  // threshold filter zeroes out `chunks` for a below-threshold result) —
  // otherwise "no results at all" and "found something too weak to trust"
  // would be indistinguishable in rag_query_log, and the admin dashboard's
  // "low-relevance retrievals" stat (SOW §16) needs exactly that distinction.
  recordRetrieval({ domain, query: trimmedQuery, resultCount: result.rawResultCount, topScore: result.topScore, belowThreshold: result.rawResultCount > 0 && !result.hasResults, latencyMs, cacheHit: false });
  return { chunks: result.chunks, hasResults: result.hasResults };
}

async function runRetrieval({ trimmedQuery, domain, sourceId, topK, minRelevance }) {
  try {
    const queryEmbedding = await embedQueryText(trimmedQuery);
    const merged = await hybridSearch({ queryText: trimmedQuery, queryEmbedding, domain, sourceId, topK });

    const topVectorScore = merged.reduce((max, c) => (c.vectorScore != null && c.vectorScore > max ? c.vectorScore : max), 0);
    // Gated on vector score ALONE, calibrated against real measurements
    // against this project's own live Atlas cluster + gemini-embedding-001
    // (see DEFAULT_MIN_RELEVANCE's comment) — genuinely relevant matches
    // scored ~0.89-0.91 cosine similarity, genuinely unrelated queries
    // still scored ~0.72-0.77 (embeddings for any two pieces of natural
    // English text cluster higher than intuition suggests). An earlier
    // version of this function also treated "matched via text search at
    // all" as automatically sufficient, on the theory that Atlas Search
    // only returns real term matches — true, but "matched at least one
    // common word" turned out to be far too weak a bar in practice (a
    // live test against an off-topic query returned a text-search hit
    // that clearly shouldn't have passed). Hybrid search still improves
    // RANKING (RRF below already blends both signals) and rescues exact
    // technical terms that happen to also clear the vector floor — which
    // gemini-embedding-001 handled fine for a deliberately novel/made-up
    // test term — but it no longer overrides the relevance gate itself.
    const hasResults = merged.length > 0 && topVectorScore >= minRelevance;

    const chunks = merged.map((c) => ({
      sourceId: c.sourceId, domain: c.domain, title: c.title, section: c.section,
      category: c.category, url: c.url, text: c.text, vectorScore: c.vectorScore,
    }));

    return { chunks: hasResults ? chunks : [], hasResults, topScore: topVectorScore || null, rawResultCount: merged.length };
  } catch (err) {
    console.error(`rag/retrieve: retrieval failed for domain=${domain}:`, err);
    return { chunks: [], hasResults: false, topScore: null, rawResultCount: 0 };
  }
}

/** Renders `Source: X — Y` lines for the chunks actually used in a reply —
 *  never lists a source that wasn't really retrieved. */
export function formatAttribution(chunks) {
  if (!chunks || chunks.length === 0) return "";
  const seen = new Set();
  const lines = [];
  for (const c of chunks) {
    const label = c.section ? `${c.title} — ${c.section}` : c.title;
    if (seen.has(label)) continue;
    seen.add(label);
    lines.push(`Source: ${label}`);
  }
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}
