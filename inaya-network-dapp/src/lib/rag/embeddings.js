// src/lib/rag/embeddings.js
//
// Embedding generation via Gemini's embedContent API — @google/genai is
// already the sole AI provider in this codebase (chat/security-chat/
// learn-chat/business-chat all use it), so this adds zero new API keys
// or vendor accounts. Model: gemini-embedding-001, 768 output dimensions
// (the smallest of Google's three recommended sizes — 768/1536/3072 —
// chosen to keep the Atlas Vector Search index compact; MTEB-competitive
// at this size per Google's own benchmarks, and this is a small-to-
// medium knowledge base, not a massive corpus that would need more).
//
// Content-hash-keyed cache in rag_embedding_cache: re-ingestion runs
// mostly re-process unchanged text (ingest.js only calls this for
// new/changed chunks anyway, but a source can be re-chunked with the same
// resulting text across a code change), and the cache also means two
// different sources that happen to contain identical text only ever pay
// for one embedding call.
//
// Client created fresh per call, same "don't cache a client that might
// have loaded before GEMINI_API_KEY was ready" discipline every other AI
// route in this codebase already follows.

import { GoogleGenAI } from "@google/genai";
import { getRagCollections } from "./collections.js";
import { hashText } from "./chunking.js";

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

/** Embeds one piece of text. taskType matters for gemini-embedding-001's
 *  quality — "RETRIEVAL_DOCUMENT" for chunks going into the index,
 *  "RETRIEVAL_QUERY" for a user's search query; using the wrong one for
 *  either side doesn't error, it just retrieves worse, so callers must
 *  pass the right one rather than relying on a default. Returns null
 *  (never throws) on any failure — retrieve.js and ingest.js both treat a
 *  null embedding as "skip this one, don't fail the whole batch/request." */
export async function embedText(text, { taskType, useCache = true } = {}) {
  if (!text || !text.trim()) return null;
  const contentHash = hashText(`${taskType}:${text}`);

  if (useCache) {
    try {
      const { ragEmbeddingCache } = await getRagCollections();
      const cached = await ragEmbeddingCache.findOne({ contentHash });
      if (cached) return cached.embedding;
    } catch (err) {
      console.error("rag/embeddings: cache read failed (continuing without cache):", err);
    }
  }

  const ai = getGeminiClient();
  if (!ai) {
    console.error("rag/embeddings: GEMINI_API_KEY is missing.");
    return null;
  }

  try {
    const result = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text.slice(0, 8000),
      config: { taskType, outputDimensionality: EMBEDDING_DIMENSIONS },
    });
    const embedding = result?.embeddings?.[0]?.values;
    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error("rag/embeddings: unexpected embedContent response shape.");
      return null;
    }

    if (useCache) {
      try {
        const { ragEmbeddingCache } = await getRagCollections();
        await ragEmbeddingCache.updateOne(
          { contentHash },
          { $setOnInsert: { contentHash, embedding, model: EMBEDDING_MODEL, createdAt: new Date().toISOString() } },
          { upsert: true }
        );
      } catch (err) {
        console.error("rag/embeddings: cache write failed (embedding still returned):", err);
      }
    }

    return embedding;
  } catch (err) {
    console.error("rag/embeddings: embedContent call failed:", err);
    return null;
  }
}

export function embedChunkText(text) {
  return embedText(text, { taskType: "RETRIEVAL_DOCUMENT" });
}

export function embedQueryText(text) {
  return embedText(text, { taskType: "RETRIEVAL_QUERY", useCache: false });
}
