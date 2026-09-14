// test/voice-usage.test.mjs
//
// Real-Atlas integration test for src/lib/ai-voice-session.js's session
// lifecycle logging (SOW §17: usage measurement; SOW §18: no raw audio
// stored). RUN_ID-scoped fixtures + before/after cleanup, matching
// test/ai-action-requests.test.mjs's established convention.
//
// Run with: node --env-file=.env.local --test test/voice-usage.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { logVoiceSessionStart, logVoiceSessionEnd } from "../src/lib/ai-voice-session.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = `test-voiceusage-${RUN_ID}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { voiceSessions, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await voiceSessions.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function newOrgId() {
  const id = new ObjectId();
  cleanup.orgIds.push(id);
  return id;
}

test("logVoiceSessionStart inserts a real, immediately-queryable row with no audio field", async () => {
  const orgId = newOrgId();
  const recordId = await logVoiceSessionStart({ orgId, email, model: "gemini-live-2.5-flash-preview" });

  const row = await collections.voiceSessions.findOne({ _id: recordId });
  assert.ok(row);
  assert.equal(row.orgId.toString(), orgId.toString());
  assert.equal(row.userEmail, email);
  assert.equal(row.model, "gemini-live-2.5-flash-preview");
  assert.ok(row.startedAt instanceof Date);
  assert.equal(row.endedAt, null);
  assert.equal(row.requestCount, 0);

  // SOW §18: never store raw microphone audio -- a structural guarantee,
  // not just discipline, since the schema simply has no such field.
  assert.equal(row.audio, undefined);
  assert.equal(row.audioData, undefined);
  assert.equal(row.rawAudio, undefined);
});

test("logVoiceSessionEnd fills in duration/counts/endReason and writes one org-activity entry", async () => {
  const orgId = newOrgId();
  const recordId = await logVoiceSessionStart({ orgId, email, model: "gemini-live-2.5-flash-preview" });

  await logVoiceSessionEnd({
    recordId, orgId, email,
    durationMs: 45_000, requestCount: 120, toolCallCount: 3, errorCount: 1,
    endReason: "user_stopped",
  });

  const row = await collections.voiceSessions.findOne({ _id: recordId });
  assert.ok(row.endedAt instanceof Date);
  assert.equal(row.durationMs, 45_000);
  assert.equal(row.requestCount, 120);
  assert.equal(row.toolCallCount, 3);
  assert.equal(row.errorCount, 1);
  assert.equal(row.endReason, "user_stopped");

  const activity = await collections.orgActivity.findOne({ orgId, recordType: "VOICE_SESSION", recordId });
  assert.ok(activity, "session end must be audit-logged exactly like other lifecycle events (e.g. OAuth connect/disconnect)");
  assert.equal(activity.action, "VOICE_SESSION_ENDED");
});

test("two sessions for the same org+user are tracked as separate rows, not merged", async () => {
  const orgId = newOrgId();
  const id1 = await logVoiceSessionStart({ orgId, email, model: "gemini-live-2.5-flash-preview" });
  const id2 = await logVoiceSessionStart({ orgId, email, model: "gemini-live-2.5-flash-preview" });
  assert.notEqual(id1.toString(), id2.toString());

  const rows = await collections.voiceSessions.find({ orgId }).toArray();
  assert.equal(rows.length, 2);
});
