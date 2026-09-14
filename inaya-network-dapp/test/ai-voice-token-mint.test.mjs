// test/ai-voice-token-mint.test.mjs
//
// The ONE test in this SOW that calls the real Gemini API for real -- it
// exists specifically to resolve, empirically, the single biggest open
// risk flagged in the implementation plan: does this Google Cloud
// project's configured GEMINI_API_KEY actually have Live API + ephemeral
// auth token (ai.authTokens.create) access enabled? The SDK exposing the
// method doesn't guarantee the account is provisioned for it. If this
// fails, that is reported as a real, honest limitation -- never worked
// around or faked.
//
// Run with: node --env-file=.env.local --test test/ai-voice-token-mint.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { mintVoiceToken } from "../src/lib/ai-voice-session.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// mintVoiceToken's buildBusinessContext call opens a real MongoDB
// connection (via getAccessibleScope) -- without closing it, node --test
// never exits on its own once the assertions finish (the exact issue that
// made this test appear to "hang" during development, when it had
// actually already passed or failed within its own timeout).
after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

test("mintVoiceToken returns a real, usable ephemeral token from the live Gemini API", { skip: !process.env.GEMINI_API_KEY && "GEMINI_API_KEY not configured" }, async () => {
  const result = await mintVoiceToken({
    orgId: new ObjectId(),
    membership: { role: "member" },
    email: "voice-token-test@example.com",
    org: { name: "Voice Token Test Co" },
    currentView: null,
  });

  if (result.error) {
    console.error(`\n  KNOWN LIMITATION -- ai.authTokens.create() failed: "${result.error}". This means the configured GEMINI_API_KEY's Google Cloud project is not (yet) provisioned for Gemini Live API ephemeral tokens. See the final report's "known limitations" section.\n`);
  }

  assert.ok(!result.error, `Expected a real ephemeral token; got error: ${result.error}`);
  assert.equal(typeof result.token, "string");
  assert.ok(result.token.length > 10, "token should be a real, non-trivial string");
  assert.equal(typeof result.model, "string");
  assert.equal(typeof result.expiresAt, "string");
  assert.ok(!Number.isNaN(new Date(result.expiresAt).getTime()));

  // The single most important negative assertion in this whole SOW: the
  // minted token must never equal (or contain) the real permanent API key.
  assert.notEqual(result.token, process.env.GEMINI_API_KEY);
  assert.ok(!result.token.includes(process.env.GEMINI_API_KEY));
});
