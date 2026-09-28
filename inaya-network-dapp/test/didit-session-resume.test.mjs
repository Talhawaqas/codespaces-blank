// test/didit-session-resume.test.mjs
//
// Regression test for the real bug reported by users: KYC status stuck on
// "pending" forever because /api/referrals/activate and .../redeem reused
// an existing session's URL unconditionally, without ever checking whether
// that Didit session could still actually be completed. Fixed by
// isDiditSessionStillUsable() (src/lib/referrals.js).
//
// Uses the real Didit API (DIDIT_API_KEY from .env.local) rather than a
// mock -- a nonexistent session ID genuinely 404s against Didit's real
// endpoint, and a freshly-created real session genuinely comes back
// "Not Started"/pending, so both branches are exercised for real.
//
// Run with: node --test test/didit-session-resume.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { isDiditSessionStillUsable } from "../src/lib/referrals.js";
import { createDiditSession } from "../src/lib/didit.js";

test("isDiditSessionStillUsable: a nonexistent/expired session is correctly reported as dead", async () => {
  const usable = await isDiditSessionStillUsable("00000000-0000-0000-0000-000000000000");
  assert.equal(usable, false, "a session Didit has no record of must never be handed back to the user again");
});

test("isDiditSessionStillUsable: null/missing sessionId is dead, not 'assume usable'", async () => {
  assert.equal(await isDiditSessionStillUsable(null), false);
  assert.equal(await isDiditSessionStillUsable(undefined), false);
  assert.equal(await isDiditSessionStillUsable(""), false);
});

test("isDiditSessionStillUsable: a freshly-created real session is reported as usable", async () => {
  const session = await createDiditSession({ vendorData: "test:didit-session-resume" });
  assert.ok(session.sessionId, "expected a real session to be created");

  const usable = await isDiditSessionStillUsable(session.sessionId);
  assert.equal(usable, true, "a brand-new, not-yet-completed session must still be reusable");
});
