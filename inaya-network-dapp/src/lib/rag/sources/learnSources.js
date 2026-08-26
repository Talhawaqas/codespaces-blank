// src/lib/rag/sources/learnSources.js
//
// Two very different kinds of "learn" source:
//  1. LEARN_STATIC_SOURCES — learnConfig.js's categories/collections/paths,
//     batch-ingested like every other static source via ingestAllStaticSources().
//  2. ensureVideoTranscriptIngested() — per-video, ingested LAZILY on first
//     access from learn-chat/route.js, not part of the batch job. A
//     transcript never changes once posted, so once ingested it's done —
//     no re-ingestion needed, unlike the static sources above.
//
// See youtubeTranscript.js's header comment for the honest caveats on
// HOW transcripts are fetched (unofficial YouTube surface, ToS gray area,
// always fails gracefully). This file is where that graceful failure
// actually protects the caller: any fetch/embedding failure here means
// ensureVideoTranscriptIngested() returns false and learn-chat/route.js
// proceeds exactly as it did before this feature existed.

import { chunkParagraphs, chunkStructuredSections } from "../chunking.js";
import { embedChunkText } from "../embeddings.js";
import { upsertChunks } from "../vectorStore.js";
import { getRagCollections } from "../collections.js";
import { fetchYouTubeTranscript } from "../youtubeTranscript.js";
import { LEARN_CATEGORIES, LEARN_COLLECTIONS, LEARN_PATHS } from "../../learnConfig.js";

function categoriesAdapter() {
  const sections = [{
    number: "01", title: "Learn Categories",
    blocks: [{ type: "paragraphs", text: LEARN_CATEGORIES.map((c) => `${c.name}: search focus "${c.searchKeywords}".`) }],
  }];
  return chunkStructuredSections(sections, { sourceId: "learn-categories", domain: "learn", title: "Inaya Learn — Categories", category: "config", url: "/learn" });
}

function collectionsAdapter() {
  const sections = LEARN_COLLECTIONS.map((collection, i) => ({
    number: String(i + 1).padStart(2, "0"),
    title: collection.title,
    blocks: [{
      type: "paragraphs",
      text: [collection.description, `Topics: ${collection.topics.map((t) => t.title).join(", ")}.`],
    }],
  }));
  return chunkStructuredSections(sections, { sourceId: "learn-collections", domain: "learn", title: "Inaya Learn — Curated Collections", category: "config", url: "/learn" });
}

function pathsAdapter() {
  const sections = LEARN_PATHS.map((path, i) => ({
    number: String(i + 1).padStart(2, "0"),
    title: path.title,
    blocks: [{ type: "paragraphs", text: [`Steps: ${path.steps.map((s) => s.title).join(" → ")}.`] }],
  }));
  return chunkStructuredSections(sections, { sourceId: "learn-paths", domain: "learn", title: "Inaya Learn — Learning Paths", category: "config", url: "/learn" });
}

export const LEARN_STATIC_SOURCES = [
  { sourceId: "learn-categories", domain: "learn", adapter: categoriesAdapter },
  { sourceId: "learn-collections", domain: "learn", adapter: collectionsAdapter },
  { sourceId: "learn-paths", domain: "learn", adapter: pathsAdapter },
];

const TRANSCRIPT_TIMEOUT_MS = 8000;
const TRANSCRIPT_CHUNK_CHARS = 900; // roughly 2-3 minutes of typical spoken-word captions per chunk

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** Idempotent and safe under concurrent calls for the same video: checks
 *  for existing chunks first (cheap read), and even if two requests race
 *  past that check, upsertChunks() is a deterministic upsert keyed by
 *  chunkKey, so a duplicate fetch just overwrites identical content rather
 *  than creating a mess. Returns true if the video's transcript is (now)
 *  available for retrieval, false if it isn't (never throws). */
export async function ensureVideoTranscriptIngested(videoId, videoTitle) {
  if (!videoId) return false;
  const sourceId = `youtube:${videoId}`;

  try {
    const { ragChunks } = await getRagCollections();
    const existing = await ragChunks.findOne({ sourceId }, { projection: { _id: 1 } });
    if (existing) return true;

    const transcript = await withTimeout(fetchYouTubeTranscript(videoId), TRANSCRIPT_TIMEOUT_MS, null);
    if (!transcript?.fullText) return false;

    const rawChunks = chunkParagraphs(transcript.fullText, {
      sourceId, domain: "learn", title: videoTitle || "This video", section: "transcript",
      category: "video-transcript", url: `https://www.youtube.com/watch?v=${videoId}`, maxChars: TRANSCRIPT_CHUNK_CHARS,
    });

    const embedded = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const embedding = await embedChunkText(rawChunks[i].text);
      if (embedding) embedded.push({ ...rawChunks[i], chunkKey: `${sourceId}::${i}`, videoId, embedding, domain: "learn" });
    }
    if (embedded.length === 0) return false;

    await upsertChunks(embedded);
    return true;
  } catch (err) {
    console.error(`rag/learnSources: transcript ingestion failed for video ${videoId} (falling back gracefully):`, err.message);
    return false;
  }
}
