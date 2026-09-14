// test/ai-voice-session.test.mjs
//
// isVoiceEnabledForOrg's flag-combination logic (pure) and
// buildVoiceLiveConfig's returned shape, including a literal string-search
// assertion that nothing it returns ever contains the real GEMINI_API_KEY
// value -- an automatable version of the SOW's "credential leakage"
// security-test category (SOW §22). buildVoiceLiveConfig calls the real
// buildBusinessContext/getAccessibleScope (read-only, scoped by orgId
// across empty collections for a fresh random org -- no fixture data or
// cleanup needed, matching this file's real-DB, no-mocks convention).
//
// Run with: node --env-file=.env.local --test test/ai-voice-session.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { isVoiceEnabledForOrg, buildVoiceLiveConfig } from "../src/lib/ai-voice-session.js";
import mongoClientPromise from "../src/lib/mongodb.js";

after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

test("isVoiceEnabledForOrg requires BOTH the global flag and the per-org opt-in", () => {
  const originalEnv = process.env.VOICE_AI_ENABLED;
  try {
    process.env.VOICE_AI_ENABLED = "true";
    assert.equal(isVoiceEnabledForOrg({ aiPolicy: { voiceEnabled: true } }), true);
    assert.equal(isVoiceEnabledForOrg({ aiPolicy: { voiceEnabled: false } }), false);
    assert.equal(isVoiceEnabledForOrg({ aiPolicy: {} }), false);
    assert.equal(isVoiceEnabledForOrg({}), false);
    assert.equal(isVoiceEnabledForOrg(null), false);

    process.env.VOICE_AI_ENABLED = "false";
    assert.equal(isVoiceEnabledForOrg({ aiPolicy: { voiceEnabled: true } }), false, "global kill switch must win even if the org opted in");

    delete process.env.VOICE_AI_ENABLED;
    assert.equal(isVoiceEnabledForOrg({ aiPolicy: { voiceEnabled: true } }), false, "unset env must default to disabled, never enabled");
  } finally {
    if (originalEnv === undefined) delete process.env.VOICE_AI_ENABLED;
    else process.env.VOICE_AI_ENABLED = originalEnv;
  }
});

test("buildVoiceLiveConfig returns a model, a string systemInstruction, and Gemini-shaped tools", async () => {
  const orgId = new ObjectId();
  const config = await buildVoiceLiveConfig({
    orgId, membership: { role: "member" }, email: "voice-test@example.com",
    org: { name: "Acme Test Co" }, currentView: "dashboard",
  });

  assert.equal(typeof config.model, "string");
  assert.ok(config.model.length > 0);
  assert.equal(typeof config.systemInstruction, "string");
  assert.ok(Array.isArray(config.tools));
  assert.ok(config.tools[0].functionDeclarations.length > 0, "must reuse the real BUSINESS_TOOL_DECLARATIONS, not an empty tool set");
  assert.ok(config.ctx, "must include a real, permission-scoped ctx for the caller");
  assert.equal(config.ctx.currentView, "dashboard");
});

test("buildVoiceLiveConfig's system instruction mentions the real org name and never leaks GEMINI_API_KEY", async () => {
  const orgId = new ObjectId();
  const config = await buildVoiceLiveConfig({
    orgId, membership: { role: "owner" }, email: "voice-test@example.com",
    org: { name: "UniqueOrgName123" }, currentView: null,
  });

  assert.ok(config.systemInstruction.includes("UniqueOrgName123"));

  const serialized = JSON.stringify(config);
  if (process.env.GEMINI_API_KEY) {
    assert.ok(!serialized.includes(process.env.GEMINI_API_KEY), "the real Gemini API key must never appear anywhere in a voice config payload");
  }
});

test("buildVoiceLiveConfig's voice addendum instructs concise, spoken-style answers", async () => {
  const orgId = new ObjectId();
  const config = await buildVoiceLiveConfig({
    orgId, membership: { role: "member" }, email: "voice-test@example.com",
    org: { name: "Acme Test Co" }, currentView: null,
  });
  assert.ok(/voice/i.test(config.systemInstruction));
  assert.ok(/concise|short/i.test(config.systemInstruction));
});
