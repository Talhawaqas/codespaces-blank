// test/rag-learn-transcript.test.mjs
//
// youtubeTranscript.js/learnSources.js's graceful-failure behavior — the
// property everything else about video-transcript ingestion depends on
// never breaking the Learn Tutor. Deliberately does NOT depend on any
// real video's captions staying available (that would make this suite
// flaky against something Inaya doesn't control) — uses an invalid video
// ID, which reliably exercises the "no transcript available" path the
// exact same way a private/caption-less/removed video would.
//
// Run with: node --env-file=.env.local --test test/rag-learn-transcript.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fetchYouTubeTranscript } from "../src/lib/rag/youtubeTranscript.js";
import { ensureVideoTranscriptIngested } from "../src/lib/rag/sources/learnSources.js";
import { getRagCollections } from "../src/lib/rag/collections.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const fakeVideoId = `test-invalid-${RUN_ID}`;

after(async () => {
  const { ragChunks } = await getRagCollections();
  await ragChunks.deleteMany({ sourceId: `youtube:${fakeVideoId}` });
  const client = await mongoClientPromise;
  await client.close();
});

test("fetchYouTubeTranscript: returns null (never throws) for an invalid/nonexistent video ID", async () => {
  const result = await fetchYouTubeTranscript(fakeVideoId);
  assert.equal(result, null);
});

test("fetchYouTubeTranscript: returns null (never throws) for empty/missing input", async () => {
  assert.equal(await fetchYouTubeTranscript(""), null);
  assert.equal(await fetchYouTubeTranscript(null), null);
  assert.equal(await fetchYouTubeTranscript(undefined), null);
});

test("ensureVideoTranscriptIngested: returns false gracefully when no transcript is available, and never throws", async () => {
  const result = await ensureVideoTranscriptIngested(fakeVideoId, "A fake test video");
  assert.equal(result, false);

  const { ragChunks } = await getRagCollections();
  const stored = await ragChunks.countDocuments({ sourceId: `youtube:${fakeVideoId}` });
  assert.equal(stored, 0, "a failed transcript fetch must not leave partial/empty chunks behind");
});

test("ensureVideoTranscriptIngested: a second call for the same (failing) video is still safe and idempotent", async () => {
  const first = await ensureVideoTranscriptIngested(fakeVideoId, "A fake test video");
  const second = await ensureVideoTranscriptIngested(fakeVideoId, "A fake test video");
  assert.equal(first, false);
  assert.equal(second, false);
});

test("ensureVideoTranscriptIngested: a missing videoId returns false immediately", async () => {
  assert.equal(await ensureVideoTranscriptIngested(null), false);
  assert.equal(await ensureVideoTranscriptIngested(""), false);
});
