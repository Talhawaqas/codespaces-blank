// test/voice-rate-limit.test.mjs
//
// Pure unit tests, no DB -- see src/lib/voice-rate-limit.js's own header
// for why this is in-memory (no shared store exists in this codebase).
//
// Run with: node --env-file=.env.local --test test/voice-rate-limit.test.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, trackConcurrentSession, __resetForTests } from "../src/lib/voice-rate-limit.js";

beforeEach(() => __resetForTests());

test("session_start: allows up to the configured max, then blocks", () => {
  const max = Number(process.env.GEMINI_VOICE_RATE_LIMIT) || 5;
  const key = "org1:alice@example.com";
  for (let i = 0; i < max; i++) {
    assert.equal(checkRateLimit(key, "session_start").allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = checkRateLimit(key, "session_start");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
});

test("tool_call: allows up to 60/min, then blocks", () => {
  const key = "org1:alice@example.com";
  for (let i = 0; i < 60; i++) {
    assert.equal(checkRateLimit(key, "tool_call").allowed, true);
  }
  assert.equal(checkRateLimit(key, "tool_call").allowed, false);
});

test("different keys are isolated from each other", () => {
  const max = Number(process.env.GEMINI_VOICE_RATE_LIMIT) || 5;
  for (let i = 0; i < max; i++) checkRateLimit("orgA:alice@example.com", "session_start");
  assert.equal(checkRateLimit("orgA:alice@example.com", "session_start").allowed, false);
  // A different org+user key must not be affected by orgA:alice's usage.
  assert.equal(checkRateLimit("orgB:bob@example.com", "session_start").allowed, true);
});

test("different kinds for the same key are tracked independently", () => {
  const key = "org1:alice@example.com";
  const max = Number(process.env.GEMINI_VOICE_RATE_LIMIT) || 5;
  for (let i = 0; i < max; i++) checkRateLimit(key, "session_start");
  assert.equal(checkRateLimit(key, "session_start").allowed, false);
  // tool_call has its own window/counter, unaffected by session_start's.
  assert.equal(checkRateLimit(key, "tool_call").allowed, true);
});

test("throws on an unknown rate-limit kind", () => {
  assert.throws(() => checkRateLimit("org1:alice@example.com", "not_a_real_kind"));
});

test("concurrent sessions: caps at 2 per key, close() frees a slot", () => {
  const key = "org1:alice@example.com";
  assert.equal(trackConcurrentSession(key, "s1", "open").allowed, true);
  assert.equal(trackConcurrentSession(key, "s2", "open").allowed, true);
  const third = trackConcurrentSession(key, "s3", "open");
  assert.equal(third.allowed, false);
  assert.equal(third.current, 2);

  trackConcurrentSession(key, "s1", "close");
  assert.equal(trackConcurrentSession(key, "s3", "open").allowed, true);
});

test("concurrent sessions: different keys have independent caps", () => {
  assert.equal(trackConcurrentSession("orgA:alice@example.com", "s1", "open").allowed, true);
  assert.equal(trackConcurrentSession("orgA:alice@example.com", "s2", "open").allowed, true);
  // orgB:bob is a completely different key -- must not be capped by orgA:alice's 2 open sessions.
  assert.equal(trackConcurrentSession("orgB:bob@example.com", "s3", "open").allowed, true);
});

test("concurrent sessions: closing a session that was never opened is a no-op, not an error", () => {
  assert.doesNotThrow(() => trackConcurrentSession("org1:alice@example.com", "never-opened", "close"));
});

test("throws on an unknown concurrent-session action", () => {
  assert.throws(() => trackConcurrentSession("org1:alice@example.com", "s1", "pause"));
});
