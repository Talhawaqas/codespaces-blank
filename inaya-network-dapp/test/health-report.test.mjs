// test/health-report.test.mjs -- the daily health report email (src/lib/healthReport.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHealthEmail } from "../src/lib/healthReport.js";

const day = "2026-10-25";

test("all clear when the routine reported ok and the database answers", () => {
  const e = buildHealthEmail({ report: { status: "ok", summary: "No failures in 24h." }, live: { ok: true, ms: 120 }, day });
  assert.equal(e.subject, "Inaya daily health report, 2026-10-25: All clear");
  assert.match(e.text, /database OK \(120 ms\)/);
  assert.match(e.text, /No failures in 24h\./);
});

test("problem when the routine found one, or the database is down at send time", () => {
  assert.match(buildHealthEmail({ report: { status: "problem", summary: "x" }, live: { ok: true, ms: 5 }, day }).subject, /Problem found$/);
  const down = buildHealthEmail({ report: { status: "ok", summary: "x" }, live: { ok: false }, day });
  assert.match(down.subject, /Problem found$/);
  assert.match(down.text, /NOT answering/);
});

test("a missing report is called out, never reported as all clear", () => {
  const e = buildHealthEmail({ report: null, live: { ok: true, ms: 9 }, day });
  assert.match(e.subject, /No report from the daily AI check$/);
  assert.match(e.text, /claude\.ai\/code\/routines/);
});

test("report text is escaped in the HTML body", () => {
  const e = buildHealthEmail({ report: { status: "ok", summary: "<script>alert(1)</script>" }, live: { ok: true, ms: 1 }, day });
  assert.ok(!e.html.includes("<script>"));
  assert.ok(e.html.includes("&lt;script&gt;"));
});
