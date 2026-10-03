// test/ai-security-anomaly.test.mjs
//
// detectAnomalies() is a pure function, so these tests use synthetic event histories and need no
// database. Run: node --test test/ai-security-anomaly.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies } from "../src/lib/aiSecurity/anomaly.js";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
let seq = 0;
const ev = (msAgo, { actor = "a@x.com", decision = "BLOCK", category = "PROMPT_INJECTION" } = {}) =>
  ({ _id: `e${++seq}`, actorEmail: actor, decision, category, timestamp: new Date(NOW - msAgo).toISOString() });

/** A quiet, steady week: one blocked request every 6 hours by a rotating cast. */
function quietWeek() {
  const out = [];
  let k = 0;
  for (let h = 2; h < 24 * 7; h += 6) out.push(ev(h * HOUR, { actor: `u${h % 4}@x.com`, category: k++ % 2 ? "PII" : "PROMPT_INJECTION" }));
  for (let h = 2; h < 24 * 7; h += 1) out.push(ev(h * HOUR + 5 * MIN, { decision: "ALLOW", actor: `u${h % 4}@x.com` })); // routine allowed traffic
  return out;
}

const types = (r) => r.anomalies.map((a) => a.type);

test("a quiet organization produces no anomalies", () => {
  const r = detectAnomalies(quietWeek(), { now: NOW });
  assert.deepEqual(r.anomalies, []);
  assert.equal(r.summary.eventsInWindow, 0);
});

test("an empty history and a handful of events never alert (no baseline, and below the minimum)", () => {
  assert.deepEqual(detectAnomalies([], { now: NOW }).anomalies, []);
  const few = [ev(5 * MIN), ev(6 * MIN), ev(7 * MIN)];
  assert.deepEqual(detectAnomalies(few, { now: NOW }).anomalies, []);
});

test("ACTOR_BLOCK_SPIKE: one person suddenly blocked many times", () => {
  const events = [...quietWeek(), ...Array.from({ length: 12 }, (_, i) => ev((i + 1) * 3 * MIN, { actor: "mallory@x.com", category: "UNAUTHORIZED_ACCESS" }))];
  const r = detectAnomalies(events, { now: NOW });
  const hit = r.anomalies.find((a) => a.type === "ACTOR_BLOCK_SPIKE");
  assert.ok(hit, "expected an actor spike");
  assert.equal(hit.actor, "mallory@x.com");
  assert.equal(hit.count, 12);
  assert.ok(hit.evidence.length > 0);
});

test("ORG_BLOCK_SPIKE: org-wide blocked volume far above the hourly baseline", () => {
  const events = [...quietWeek(), ...Array.from({ length: 15 }, (_, i) => ev((i + 1) * 2 * MIN, { actor: `u${i}@x.com` }))];
  const r = detectAnomalies(events, { now: NOW });
  assert.ok(types(r).includes("ORG_BLOCK_SPIKE"));
});

test("REQUEST_BURST: 25 requests from one actor inside a minute, even though they were all allowed", () => {
  const events = [...quietWeek(), ...Array.from({ length: 25 }, (_, i) => ev(10 * MIN + i * 1000, { actor: "bot@x.com", decision: "ALLOW" }))];
  const r = detectAnomalies(events, { now: NOW });
  const hit = r.anomalies.find((a) => a.type === "REQUEST_BURST");
  assert.ok(hit);
  assert.equal(hit.actor, "bot@x.com");
  assert.ok(hit.count >= 20);
});

test("a steady heavy user is not a burst: 25 requests spread over 25 minutes", () => {
  const events = Array.from({ length: 25 }, (_, i) => ev((i + 1) * MIN, { actor: "busy@x.com", decision: "ALLOW" }));
  assert.ok(!types(detectAnomalies(events, { now: NOW })).includes("REQUEST_BURST"));
});

test("NEW_ATTACK_CATEGORY: a category with no history appears repeatedly", () => {
  const events = [...quietWeek(), ...Array.from({ length: 4 }, (_, i) => ev((i + 1) * 5 * MIN, { actor: "x@x.com", category: "EXCESSIVE_AGENCY" }))];
  const r = detectAnomalies(events, { now: NOW });
  const hit = r.anomalies.find((a) => a.type === "NEW_ATTACK_CATEGORY");
  assert.ok(hit);
  assert.equal(hit.category, "EXCESSIVE_AGENCY");
});

test("a category the org has seen before is not 'new'", () => {
  const events = [...quietWeek(), ...Array.from({ length: 4 }, (_, i) => ev((i + 1) * 5 * MIN, { category: "PII" }))];
  assert.ok(!types(detectAnomalies(events, { now: NOW })).includes("NEW_ATTACK_CATEGORY"));
});

test("COORDINATED_PROBING: several different people trigger the same category", () => {
  const events = [...quietWeek(), ...Array.from({ length: 6 }, (_, i) => ev((i + 1) * 4 * MIN, { actor: `p${i % 3}@x.com`, category: "UNAUTHORIZED_ACCESS" }))];
  const r = detectAnomalies(events, { now: NOW });
  const hit = r.anomalies.find((a) => a.type === "COORDINATED_PROBING");
  assert.ok(hit);
  assert.equal(hit.severity, "HIGH");
  assert.equal(hit.actors, 3);
});

test("the spike is not allowed to hide inside its own baseline", () => {
  // Same volume as the spike spread across the previous 24 hours is a busy org, not a spike.
  const busy = Array.from({ length: 24 * 7 * 3 }, (_, i) => ev((i + 2) * (HOUR / 3), { actor: `u${i % 6}@x.com` }));
  const spike = Array.from({ length: 5 }, (_, i) => ev((i + 1) * 5 * MIN, { actor: `u${i % 6}@x.com` }));
  const r = detectAnomalies([...busy, ...spike], { now: NOW });
  assert.ok(!types(r).includes("ORG_BLOCK_SPIKE"), "~7 in an hour against a baseline of 3/hour is within normal variation");
});

test("results are ranked HIGH first and carry evidence ids", () => {
  const events = [
    ...quietWeek(),
    ...Array.from({ length: 6 }, (_, i) => ev((i + 1) * 4 * MIN, { actor: `p${i % 3}@x.com`, category: "UNAUTHORIZED_ACCESS" })),
    ...Array.from({ length: 25 }, (_, i) => ev(30 * MIN + i * 1000, { actor: "bot@x.com", decision: "ALLOW" })),
  ];
  const r = detectAnomalies(events, { now: NOW });
  assert.ok(r.anomalies.length >= 2);
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  for (let i = 1; i < r.anomalies.length; i++) assert.ok(order[r.anomalies[i - 1].severity] <= order[r.anomalies[i].severity]);
  for (const a of r.anomalies) assert.ok(Array.isArray(a.evidence) && a.evidence.length > 0 && a.message.length > 10);
});
