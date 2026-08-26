// test/rag-retrieval.test.mjs
//
// End-to-end hybrid retrieval against real Atlas Vector Search + Atlas
// Search indexes: a known fixture chunk must be findable both by
// semantic query (paraphrase) and exact-keyword query (a distinctive
// technical term), domain filtering must be watertight, and a genuinely
// irrelevant query must trigger the "insufficient information" path.
//
// ATLAS INDEXING LAG: a newly-inserted document isn't necessarily
// queryable via $vectorSearch/$search the instant upsertChunks() returns
// — Atlas Search indexing is near-real-time, not synchronous. Retrieval
// assertions below poll for up to ~40s rather than asserting on the
// first attempt, to test real behavior without being flaky about
// Atlas's own indexing latency (a separate concern from anything this
// codebase controls).
//
// Run with: node --env-file=.env.local --test test/rag-retrieval.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ingestSource } from "../src/lib/rag/ingest.js";
import { retrieveContext } from "../src/lib/rag/retrieve.js";
import { getRagCollections } from "../src/lib/rag/collections.js";
import { chunkParagraphs } from "../src/lib/rag/chunking.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
// A deliberately distinctive, made-up technical term — guarantees this
// exact fixture is what any test query matches, never something already
// in the real production index from a prior ingestion run.
const DISTINCTIVE_TERM = `Zorvexium-${RUN_ID}`;
const sourceId = `test-rag-retrieval-${RUN_ID}`;

let collections;

before(async () => {
  collections = await getRagCollections();
  await ingestSource({
    sourceId,
    domain: "docs",
    adapter: () => chunkParagraphs(
      `The ${DISTINCTIVE_TERM} protocol is Inaya's internal name for its client-side sharding mechanism: files are encrypted, then split into two independent pieces before upload, so no single storage provider ever holds a complete file.`,
      { sourceId, domain: "docs", title: "Test Fixture Doc", section: "Sharding" }
    ),
  });
});

after(async () => {
  await collections.ragChunks.deleteMany({ sourceId });
  await collections.ragSources.deleteMany({ sourceId });
  await collections.ragIngestionRuns.deleteMany({ sourceId });
  await collections.ragQueryLog.deleteMany({ domain: "docs", queryTextTruncated: { $regex: RUN_ID } });
  const client = await mongoClientPromise;
  await client.close();
});

async function pollUntil(fn, { timeoutMs = 50000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

test("retrieval: an exact-keyword query finds the fixture chunk via text search", async () => {
  const result = await pollUntil(async () => {
    const r = await retrieveContext({ query: `What is the ${DISTINCTIVE_TERM} protocol?`, domain: "docs", sourceId });
    return r.hasResults ? r : null;
  });
  assert.ok(result, "fixture chunk was never found by exact-keyword query within the poll window");
  assert.ok(result.chunks.some((c) => c.text.includes(DISTINCTIVE_TERM)));
});

test("retrieval: a semantic paraphrase (no shared distinctive keyword) still finds the fixture chunk via vector search", async () => {
  const result = await pollUntil(async () => {
    const r = await retrieveContext({ query: "How does Inaya split encrypted files into pieces before uploading them?", domain: "docs", sourceId });
    return r.hasResults ? r : null;
  });
  assert.ok(result, "fixture chunk was never found by semantic paraphrase within the poll window");
});

test("retrieval: domain filtering — a docs-domain fixture is never returned for a security-domain query", async () => {
  // Even polling the full window, this must stay empty — a positive
  // result here would mean domain filtering is broken, not that indexing
  // just needs more time.
  const result = await retrieveContext({ query: `What is the ${DISTINCTIVE_TERM} protocol?`, domain: "security" });
  assert.ok(!result.chunks.some((c) => c.text.includes(DISTINCTIVE_TERM)), "a docs-domain chunk leaked into a security-domain query");
});

test("retrieval: a genuinely irrelevant query yields hasResults:false (the 'insufficient information' trigger)", async () => {
  const result = await retrieveContext({ query: `Completely unrelated nonsense query about ${randomUUID()} interplanetary weather patterns on Neptune`, domain: "docs" });
  assert.equal(result.hasResults, false);
  assert.deepEqual(result.chunks, []);
});

test("retrieval: an empty query string returns hasResults:false without erroring", async () => {
  const result = await retrieveContext({ query: "", domain: "docs" });
  assert.equal(result.hasResults, false);
});
