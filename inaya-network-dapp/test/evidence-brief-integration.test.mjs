// test/evidence-brief-integration.test.mjs -- the Evidence Graph highlight in the Business Brief (counting rules, pure).
// Run: node --test --test-force-exit test/evidence-brief-integration.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceGraphBullets } from "../src/lib/evidenceBriefIntegration.js";

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ev = (status, createdAt) => ({ status, createdAt });
const run = (events, sinceDays = 7) => evidenceGraphBullets({ orgId: "o", membership: {}, sinceIso: ago(sinceDays), list: async () => events });

test("no events, no bullets (nothing is invented)", async () => assert.deepEqual(await run([]), []));

test("counts events opened in the period and those still awaiting a decision, with the age of the oldest", async () => {
  const bullets = await run([ev("OPEN", ago(1)), ev("OPEN", ago(20)), ev("DECIDED", ago(2)), ev("CLOSED", ago(40))], 7);
  assert.deepEqual(bullets, ["2 business events opened in the Evidence Graph.", "2 business events still awaiting a decision (the oldest for 20 days)."]);
});

test("singular wording, and no age when the oldest open event is under a day old", async () => {
  assert.deepEqual(await run([ev("OPEN", new Date().toISOString())]), ["1 business event opened in the Evidence Graph.", "1 business event still awaiting a decision."]);
});

test("old, already-decided events produce nothing for this period", async () => {
  assert.deepEqual(await run([ev("EXECUTED", ago(30)), ev("CLOSED", ago(60))], 7), []);
});

test("a failing event lookup throws (the brief catches it) rather than reporting made-up numbers", async () => {
  await assert.rejects(() => evidenceGraphBullets({ orgId: "o", membership: {}, sinceIso: ago(7), list: async () => { throw new Error("db down"); } }), /db down/);
});
