// test/rag-ingestion.test.mjs
//
// RAG ingestion pipeline: chunking output shape, and content-hash-based
// diffing (insert new / skip unchanged / update changed / remove
// obsolete) against real rag_chunks/rag_sources — no mocking, same
// convention as every other test in this suite (real Atlas, RUN_ID-
// namespaced fixtures, real cleanup in after()).
//
// Real embedding calls happen here (ingestSource -> embedChunkText ->
// Gemini embedContent) — bounded to a handful of tiny fixture chunks per
// test, not the full production source list (that's what
// POST /api/admin/rag/reingest is for, exercised manually per the plan's
// verification steps, not in this automated suite).
//
// Run with: node --env-file=.env.local --test test/rag-ingestion.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chunkMarkdownByHeading, chunkQaPairs, hashText } from "../src/lib/rag/chunking.js";
import { ingestSource } from "../src/lib/rag/ingest.js";
import { getRagCollections, ensureRagPlainIndexes } from "../src/lib/rag/collections.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const sourceId = (label) => `test-rag-ingest-${RUN_ID}-${label}`;

let collections;

before(async () => {
  await ensureRagPlainIndexes();
  collections = await getRagCollections();
});

after(async () => {
  const { ragChunks, ragSources, ragIngestionRuns, ragEmbeddingCache } = collections;
  await ragChunks.deleteMany({ sourceId: { $regex: `^test-rag-ingest-${RUN_ID}-` } });
  await ragSources.deleteMany({ sourceId: { $regex: `^test-rag-ingest-${RUN_ID}-` } });
  await ragIngestionRuns.deleteMany({ sourceId: { $regex: `^test-rag-ingest-${RUN_ID}-` } });
  // Embedding cache entries from this run are tiny and content-hash keyed
  // (harmless to leave, they'd just be reused by a real future doc with
  // identical text) — left uncleaned deliberately, matching the "cache
  // entries aren't test fixtures" reasoning.
  const client = await mongoClientPromise;
  await client.close();
});

// ============================================================
// Chunking shape
// ============================================================
test("chunking: chunkMarkdownByHeading splits on ## headings and carries a content hash", () => {
  const markdown = `# My Doc\n\n## Section One\nSome text here.\n\n## Section Two\nMore text here.`;
  const chunks = chunkMarkdownByHeading(markdown, { sourceId: "x", domain: "docs" });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].section, "Section One");
  assert.equal(chunks[1].section, "Section Two");
  assert.ok(chunks[0].contentHash);
  assert.equal(chunks[0].contentHash, hashText(chunks[0].text));
});

test("chunking: chunkQaPairs produces one chunk per Q&A with both question and answer in the text", () => {
  const chunks = chunkQaPairs(
    [{ q: "What is X?", a: "X is Y." }, { q: "How does Z work?", a: "Z works like W." }],
    { sourceId: "x", domain: "docs", title: "FAQ" }
  );
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].text, /What is X\?/);
  assert.match(chunks[0].text, /X is Y\./);
});

// ============================================================
// Ingestion diffing: insert / skip / update / remove-obsolete
// ============================================================
test("ingest: first run inserts every chunk, second run with identical content adds nothing new", async () => {
  const id = sourceId("diff-unchanged");
  const markdown = `# Doc\n\n## Alpha\nAlpha content.\n\n## Beta\nBeta content.`;
  const adapter = () => chunkMarkdownByHeading(markdown, { sourceId: id, domain: "docs" });

  const first = await ingestSource({ sourceId: id, domain: "docs", adapter });
  assert.equal(first.chunksAdded, 2);
  assert.equal(first.chunksUpdated, 0);

  const second = await ingestSource({ sourceId: id, domain: "docs", adapter });
  assert.equal(second.chunksAdded, 0);
  assert.equal(second.chunksUpdated, 0);
  assert.equal(second.chunksUnchanged, 2);

  const stored = await collections.ragChunks.find({ sourceId: id }).toArray();
  assert.equal(stored.length, 2);
});

test("ingest: changing one section's content updates only that chunk, leaves the other untouched", async () => {
  const id = sourceId("diff-update");
  const original = () => chunkMarkdownByHeading(`# Doc\n\n## Alpha\nOriginal alpha.\n\n## Beta\nOriginal beta.`, { sourceId: id, domain: "docs" });
  await ingestSource({ sourceId: id, domain: "docs", adapter: original });

  const before = await collections.ragChunks.findOne({ _id: `${id}::1` }); // Beta is index 1
  const beforeUpdatedAt = before.updatedAt;

  const changed = () => chunkMarkdownByHeading(`# Doc\n\n## Alpha\nCHANGED alpha content.\n\n## Beta\nOriginal beta.`, { sourceId: id, domain: "docs" });
  const result = await ingestSource({ sourceId: id, domain: "docs", adapter: changed });

  assert.equal(result.chunksAdded, 0);
  assert.equal(result.chunksUpdated, 1);
  assert.equal(result.chunksUnchanged, 1);

  const alphaAfter = await collections.ragChunks.findOne({ _id: `${id}::0` });
  assert.match(alphaAfter.text, /CHANGED/);
  const betaAfter = await collections.ragChunks.findOne({ _id: `${id}::1` });
  assert.equal(betaAfter.updatedAt, beforeUpdatedAt, "an unchanged chunk must not be rewritten (no wasted embedding call)");
});

test("ingest: removing a section from the source deletes its chunk on re-ingestion (obsolete content removal)", async () => {
  const id = sourceId("diff-remove");
  const withThree = () => chunkMarkdownByHeading(`# Doc\n\n## A\nA text.\n\n## B\nB text.\n\n## C\nC text.`, { sourceId: id, domain: "docs" });
  await ingestSource({ sourceId: id, domain: "docs", adapter: withThree });
  assert.equal(await collections.ragChunks.countDocuments({ sourceId: id }), 3);

  const withTwo = () => chunkMarkdownByHeading(`# Doc\n\n## A\nA text.\n\n## B\nB text.`, { sourceId: id, domain: "docs" });
  const result = await ingestSource({ sourceId: id, domain: "docs", adapter: withTwo });

  assert.equal(result.chunksRemoved, 1);
  assert.equal(await collections.ragChunks.countDocuments({ sourceId: id }), 2);
});

test("ingest: an ingestion run is recorded in rag_ingestion_runs and rag_sources is updated", async () => {
  const id = sourceId("run-record");
  const adapter = () => chunkMarkdownByHeading(`# Doc\n\n## Only\nOnly section.`, { sourceId: id, domain: "docs" });
  await ingestSource({ sourceId: id, domain: "docs", adapter });

  const runs = await collections.ragIngestionRuns.find({ sourceId: id }).toArray();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].chunksAdded, 1);
  assert.equal(runs[0].error, null);

  const sourceDoc = await collections.ragSources.findOne({ sourceId: id });
  assert.ok(sourceDoc.lastIngestedAt);
});
