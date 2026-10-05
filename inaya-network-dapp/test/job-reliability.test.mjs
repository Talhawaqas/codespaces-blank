// test/job-reliability.test.mjs -- background-job reliability (RELIAB-001): no overlapping runs, stale takeover, bounded backoff retries, failure recording with redaction, minimum interval
// (idempotent repeated invocations), tenant scoping, and the real cron routes behaving through the wrapper. Real MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/job-reliability.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { withJobRun, listRuns, staleRuns, redact } from "../src/lib/jobs/run.js";

const T = { timeout: 300000 };
const RUN = randomBytes(3).toString("hex"); const NAME = (n) => `test-${RUN}-${n}`; let db, orgA, orgB;
const noSleep = async () => {};
before(async () => { await setup(); db = (await getOrgCollections()).db; orgA = await makeChatOrg("jra", { people: [] }); orgB = await makeChatOrg("jrb", { people: [] }); });
after(async () => { await db.collection("job_runs").deleteMany({ name: { $regex: `^test-${RUN}` } }); await teardown(); });

test("a successful run is recorded with its result and attempts", T, async () => {
  const r = await withJobRun({ name: NAME("ok"), fn: async () => ({ processed: 3 }) }); assert.equal(r.status, "succeeded"); assert.deepEqual(r.result, { processed: 3 }); assert.equal(r.attempts, 1);
  const [row] = await listRuns({ name: NAME("ok") }); assert.equal(row.status, "succeeded"); assert.ok(row.finishedAt); assert.equal(row.orgId, null, "a platform-wide run is explicitly unscoped");
});

test("no overlapping runs: while one is live, a second of the same job and scope is skipped; different jobs and different tenants run independently", T, async () => {
  let release; const gate = new Promise((r) => (release = r)); let ran = 0;
  const first = withJobRun({ name: NAME("lock"), orgId: orgA.oid, fn: async () => { ran++; await gate; return { done: 1 }; } });
  await new Promise((r) => setTimeout(r, 1500)); const second = await withJobRun({ name: NAME("lock"), orgId: orgA.oid, fn: async () => { ran++; return {}; } }); assert.deepEqual([second.status, second.reason], ["skipped", "already running"]);
  const otherTenant = await withJobRun({ name: NAME("lock"), orgId: orgB.oid, fn: async () => { ran++; return {}; } }); assert.equal(otherTenant.status, "succeeded", "another organization's run is independent"); const otherJob = await withJobRun({ name: NAME("lock2"), orgId: orgA.oid, fn: async () => ({}) }); assert.equal(otherJob.status, "succeeded");
  release(); assert.equal((await first).status, "succeeded"); assert.equal(ran, 2, "the skipped run never executed");
  const again = await withJobRun({ name: NAME("lock"), orgId: orgA.oid, fn: async () => ({}) }); assert.equal(again.status, "succeeded", "after it finishes the job can run again");
  const runs = await listRuns({ name: NAME("lock"), orgId: orgA.oid }); assert.ok(runs.every((x) => x.orgId === orgA.oid), "runs are filtered by tenant");
});

test("simultaneous claims: of several callers started together exactly one executes", T, async () => {
  let ran = 0; const results = await Promise.all([0, 1, 2, 3].map(() => withJobRun({ name: NAME("race"), fn: async () => { ran++; await new Promise((r) => setTimeout(r, 1500)); return {}; } })));
  assert.equal(results.filter((r) => r.status === "succeeded").length, 1); assert.equal(ran, 1, "no duplicate execution"); assert.equal(results.filter((r) => r.status === "skipped").length, 3);
});

test("stale takeover: a run that stopped heartbeating is marked stale and does not block the job forever; a live one within the window still blocks", T, async () => {
  const c = db.collection("job_runs"); const old = new Date(Date.now() - 3600_000).toISOString(); const _id = new ObjectId(); await c.insertOne({ _id, name: NAME("stale"), orgId: null, status: "running", startedAt: old, heartbeatAt: old, attempts: 1, leaseKey: `${NAME("stale")}:platform` });
  assert.equal((await staleRuns({ staleSeconds: 900 })).some((s) => s.runId === String(_id)), true, "the operator view lists it");
  const r = await withJobRun({ name: NAME("stale"), staleSeconds: 900, fn: async () => ({ ok: true }) }); assert.equal(r.status, "succeeded"); assert.equal((await c.findOne({ _id })).status, "stale");
  const fresh = new Date().toISOString(); await c.insertOne({ _id: new ObjectId(), name: NAME("live"), orgId: null, status: "running", startedAt: fresh, heartbeatAt: fresh, attempts: 1, leaseKey: `${NAME("live")}:platform` }); assert.equal((await withJobRun({ name: NAME("live"), staleSeconds: 900, fn: async () => ({}) })).status, "skipped");
});

test("retry with bounded backoff, then success or a recorded failure; messages are redacted; safe re-entry after failure", T, async () => {
  const waits = []; let n = 0; const flaky = await withJobRun({ name: NAME("flaky"), retries: 2, backoffMs: [100, 200, 400], sleep: async (ms) => { waits.push(ms); }, fn: async ({ attempt }) => { n++; if (attempt < 3) throw new Error("temporary"); return { attempt }; } }); assert.equal(flaky.status, "succeeded"); assert.equal(flaky.attempts, 3); assert.deepEqual(waits, [100, 200], "bounded backoff between attempts");
  const waits2 = []; const bad = await withJobRun({ name: NAME("bad"), retries: 3, backoffMs: [10, 20], sleep: async (ms) => waits2.push(ms), fn: async () => { throw new Error("db failed at mongodb+srv://user:hunter2@cluster.example/db with token=abcd1234 Bearer eyJhbGciOi"); } });
  assert.equal(bad.status, "failed"); assert.equal(bad.attempts, 4); assert.deepEqual(waits2, [10, 20, 20], "the backoff is capped at its last step"); assert.equal(/hunter2|abcd1234|eyJhbGciOi/.test(bad.error), false, "secrets are redacted"); const [row] = await listRuns({ name: NAME("bad") }); assert.equal(row.status, "failed"); assert.equal(/hunter2|abcd1234/.test(JSON.stringify(row)), false);
  assert.equal((await withJobRun({ name: NAME("bad"), retries: 0, fn: async () => ({ recovered: true }) })).status, "succeeded", "a failed run does not block the next one"); assert.equal(redact(new Error("x".repeat(1000))).length, 240);
});

test("minimum interval: repeated invocations inside the window do not run the job again (idempotent cron)", T, async () => {
  let n = 0; const run = () => withJobRun({ name: NAME("min"), minIntervalSeconds: 3600, fn: async () => { n++; return { n }; } }); const a = await run(); const b = await run(); const c = await run(); assert.equal(a.status, "succeeded"); assert.deepEqual([b.status, c.status], ["skipped", "skipped"]); assert.equal(n, 1); assert.equal(b.reason, "ran recently");
  assert.equal((await withJobRun({ name: NAME("min2"), minIntervalSeconds: 3600, fn: async () => { throw new Error("nope"); }, retries: 0 })).status, "failed"); assert.equal((await withJobRun({ name: NAME("min2"), minIntervalSeconds: 3600, fn: async () => ({}), retries: 0 })).status, "succeeded", "a failure does not count as a recent success");
});

test("a long job keeps its claim by heartbeating", T, async () => {
  const r = await withJobRun({ name: NAME("hb"), fn: async ({ heartbeat }) => { await heartbeat(); await new Promise((r) => setTimeout(r, 300)); await heartbeat(); return { beats: 2 }; } }); assert.equal(r.status, "succeeded");
});

test("the real cron routes run through the wrapper: they refuse without the secret, report the job state, and a repeated call inside its window does not repeat the work", T, async () => {
  const { NextRequest } = await import("next/server"); process.env.CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret"; const hdr = { authorization: `Bearer ${process.env.CRON_SECRET}` };
  const share = await import("../src/app/api/cron/share-expiry/route.js"); const notes = await import("../src/app/api/cron/notes-purge/route.js"); const ha = await import("../src/app/api/cron/ha-gateway/route.js"); const hooks = await import("../src/app/api/cron/org-webhooks/route.js");
  for (const m of [share, notes, ha, hooks]) assert.equal((await m.GET(new NextRequest("http://localhost:3000/x"))).status, 401);
  const a = await notes.GET(new NextRequest("http://localhost:3000/x", { headers: hdr })); assert.equal(a.status, 200); const aj = await a.json(); assert.ok(["succeeded", "skipped"].includes(aj.job)); const b = await (await notes.GET(new NextRequest("http://localhost:3000/x", { headers: hdr }))).json(); assert.equal(b.job, "skipped", "the minimum interval makes the second call a no-op");
  for (const m of [share, ha, hooks]) { const r = await m.GET(new NextRequest("http://localhost:3000/x", { headers: hdr })); assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.success, true); }
  const names = new Set((await listRuns({ limit: 200 })).map((r) => r.name)); for (const n of ["notes-purge", "share-expiry", "org-webhooks", "ha-gateway"]) assert.ok(names.has(n), `${n} was recorded`);
});
