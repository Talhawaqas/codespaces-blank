// test/voice-rate-limit.test.mjs
//
// The voice limiter is Mongo-backed (shared across serverless instances), so these run against
// the real database like the rest of the suite.
//
// Run with: node --env-file=.env.local --test test/voice-rate-limit.test.mjs

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, trackConcurrentSession, __resetForTests } from "../src/lib/voice-rate-limit.js";
import { connectToDatabase } from "../src/lib/mongodb.js";

beforeEach(async () => { await __resetForTests(); });
after(async () => { await __resetForTests(); const { client } = await connectToDatabase(); await client?.close?.(); });

const MAX = Number(process.env.GEMINI_VOICE_RATE_LIMIT) || 5;

test("session_start: allows up to the configured max, then blocks", async () => {
  const key = "org1:alice@example.com";
  for (let i = 0; i < MAX; i++) {
    assert.equal((await checkRateLimit(key, "session_start")).allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = await checkRateLimit(key, "session_start");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
});

test("a rejected attempt doesn't extend the lockout (it is not recorded)", async () => {
  const key = "org1:alice@example.com";
  for (let i = 0; i < MAX; i++) await checkRateLimit(key, "session_start");
  const first = await checkRateLimit(key, "session_start");
  const second = await checkRateLimit(key, "session_start");
  assert.equal(first.allowed, false);
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterMs <= first.retryAfterMs);
});

test("tool_call: allows up to 60/min, then blocks", async () => {
  const key = "org1:alice@example.com";
  for (let i = 0; i < 60; i++) assert.equal((await checkRateLimit(key, "tool_call")).allowed, true);
  assert.equal((await checkRateLimit(key, "tool_call")).allowed, false);
});

test("different keys are isolated from each other", async () => {
  for (let i = 0; i < MAX; i++) await checkRateLimit("orgA:alice@example.com", "session_start");
  assert.equal((await checkRateLimit("orgA:alice@example.com", "session_start")).allowed, false);
  assert.equal((await checkRateLimit("orgB:bob@example.com", "session_start")).allowed, true);
});

test("different kinds for the same key are tracked independently", async () => {
  const key = "org1:alice@example.com";
  for (let i = 0; i < MAX; i++) await checkRateLimit(key, "session_start");
  assert.equal((await checkRateLimit(key, "session_start")).allowed, false);
  assert.equal((await checkRateLimit(key, "tool_call")).allowed, true);
});

test("concurrent calls can't both slip under the limit", async () => {
  const key = "org1:race@example.com";
  const results = await Promise.all(Array.from({ length: MAX + 4 }, () => checkRateLimit(key, "session_start")));
  assert.equal(results.filter((r) => r.allowed).length, MAX);
});

test("rejects an unknown rate-limit kind", async () => {
  await assert.rejects(() => checkRateLimit("org1:alice@example.com", "not_a_real_kind"));
});

test("concurrent sessions: caps at 2 per key, close() frees a slot", async () => {
  const key = "org1:alice@example.com";
  assert.equal((await trackConcurrentSession(key, "s1", "open")).allowed, true);
  assert.equal((await trackConcurrentSession(key, "s2", "open")).allowed, true);
  const third = await trackConcurrentSession(key, "s3", "open");
  assert.equal(third.allowed, false);
  assert.equal(third.current, 2);

  await trackConcurrentSession(key, "s1", "close");
  assert.equal((await trackConcurrentSession(key, "s3", "open")).allowed, true);
});

test("concurrent sessions: re-opening the same session id doesn't consume a second slot", async () => {
  const key = "org1:alice@example.com";
  await trackConcurrentSession(key, "s1", "open");
  await trackConcurrentSession(key, "s1", "open");
  assert.equal((await trackConcurrentSession(key, "s2", "open")).allowed, true);
});

test("concurrent sessions: different keys have independent caps", async () => {
  assert.equal((await trackConcurrentSession("orgA:alice@example.com", "s1", "open")).allowed, true);
  assert.equal((await trackConcurrentSession("orgA:alice@example.com", "s2", "open")).allowed, true);
  assert.equal((await trackConcurrentSession("orgB:bob@example.com", "s3", "open")).allowed, true);
});

test("concurrent sessions: closing a session that was never opened is a no-op", async () => {
  await assert.doesNotReject(() => trackConcurrentSession("org1:alice@example.com", "never-opened", "close"));
});

test("rejects an unknown concurrent-session action", async () => {
  await assert.rejects(() => trackConcurrentSession("org1:alice@example.com", "s1", "pause"));
});
