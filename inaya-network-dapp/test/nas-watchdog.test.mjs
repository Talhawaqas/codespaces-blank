// test/nas-watchdog.test.mjs
//
// Hosted NAS watchdog (src/lib/nas/watchdog.js): overdue enabled snapshot/backup policies notify the company's
// Owners/Admins once per UTC day per appliance, in-app + email. Email goes to an injected fake sender, never a real
// provider, and every pass is scoped to this test's own org.
//
// Run with: npm run test:one -- --test-concurrency=1 test/nas-watchdog.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { checkStaleNasSchedules, evaluatePolicy, staleAfterMs } from "../src/lib/nas/watchdog.js";
import { EVENTS } from "../src/lib/notify/router.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-naswd-${RUN_ID}-${label}@example.com`;
const HOUR = 3600000;
const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = (h, base = NOW) => new Date(base - h * HOUR).toISOString();

let c;
let orgId;
const ids = {};

function fakeSender() {
  const sent = [];
  const fn = async (msg) => { sent.push(msg); return { sent: true }; };
  fn.sent = sent;
  return fn;
}

before(async () => {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  orgId = (await c.orgs.insertOne({ name: `NAS Watchdog ${RUN_ID} Co`, createdAt: ago(1000) })).insertedId;
  const member = (role, label, extra = {}) => ({ orgId, email: email(label), role, status: "active", departmentIds: [], createdAt: ago(1000), ...extra });
  await c.orgMembers.insertMany([member("owner", "owner"), member("admin", "admin"), member("member", "staff"), member("member", "nasmgr", { nasRole: "manager" }), member("admin", "gone", { status: "removed" })]);

  const appliance = (name, extra = {}) => ({ orgId, name, backend: "wsl-local", host: "127.0.0.1", status: "REACHABLE", deletedAt: null, createdAt: ago(1000), ...extra });
  const [a1, a2, a3, aDel] = await Promise.all(["Office NAS", "Branch NAS", "Healthy NAS", "Deleted NAS"].map((n, i) => c.nasAppliances.insertOne(appliance(n, i === 3 ? { deletedAt: ago(1) } : {}))));
  Object.assign(ids, { a1: a1.insertedId, a2: a2.insertedId, a3: a3.insertedId, aDel: aDel.insertedId });

  const share = (applianceId, shareName, extra = {}) => c.nasShares.insertOne({ orgId, applianceId, shareName, deletedAt: null, createdAt: ago(1000), ...extra }).then((r) => r.insertedId);
  ids.s1 = await share(ids.a1, `docs-${RUN_ID}`);
  ids.s1b = await share(ids.a1, `finance-${RUN_ID}`);
  ids.s1gone = await share(ids.a1, `old-${RUN_ID}`, { deletedAt: ago(5) });
  ids.s2 = await share(ids.a2, `branch-${RUN_ID}`);
  ids.s3 = await share(ids.a3, `ok-${RUN_ID}`);
  ids.sDel = await share(ids.aDel, `del-${RUN_ID}`);

  const snap = (shareId, applianceId, extra) => ({ orgId, shareId, applianceId, intervalMinutes: 60, keepLast: 7, enabled: true, createdAt: ago(240), updatedAt: ago(240), nextRunAt: ago(200), ...extra });
  const bkp = (shareId, applianceId, extra) => ({ orgId, shareId, applianceId, intervalMinutes: 1440, targetIds: ["inaya"], enabled: true, createdAt: ago(240), updatedAt: ago(240), nextRunAt: ago(200), ...extra });
  await c.nasSnapshotPolicies.insertMany([
    snap(ids.s1, ids.a1, { lastRunAt: ago(5) }),                     // STALE: 5h > 2*60min + 60min
    snap(ids.s1b, ids.a1, { lastRunAt: ago(2.5) }),                  // fresh: 2.5h < 3h
    snap(ids.s1gone, ids.a1, { lastRunAt: ago(500) }),               // share deleted -> ignored
    snap(ids.s3, ids.a3, { lastRunAt: ago(1) }),                     // fresh
    snap(ids.s2, ids.a2, { enabled: false, lastRunAt: ago(500) }),   // disabled -> ignored
    snap(ids.sDel, ids.aDel, { lastRunAt: ago(500) }),               // appliance deleted -> no alert
  ]);
  await c.nasBackupPolicies.insertMany([
    bkp(ids.s1b, ids.a1, { createdAt: ago(24 * 10), updatedAt: ago(24 * 10) }), // STALE: last success 60h ago > 2*24h+1h
    bkp(ids.s2, ids.a2, { createdAt: ago(24 * 10), updatedAt: ago(24 * 10) }),  // STALE: never succeeded (only a FAILED run)
    bkp(ids.s3, ids.a3, { createdAt: ago(24 * 10), updatedAt: ago(24 * 10) }),  // fresh: COMPLETED_WITH_ERRORS 20h ago
    bkp(ids.s1, ids.a1, { createdAt: ago(0.5), updatedAt: ago(0.5) }),          // brand-new policy, never ran -> not yet stale
  ]);
  const run = (shareId, applianceId, status, h) => ({ orgId, shareId, applianceId, status, startedAt: ago(h + 0.2), completedAt: ago(h) });
  await c.nasBackupRuns.insertMany([
    run(ids.s1b, ids.a1, "COMPLETED", 60), run(ids.s1b, ids.a1, "FAILED", 2),
    run(ids.s2, ids.a2, "FAILED", 3),
    run(ids.s3, ids.a3, "COMPLETED_WITH_ERRORS", 20),
  ]);
});

after(async () => {
  const filter = { orgId };
  if (orgId) {
    await Promise.all([c.nasSnapshotPolicies, c.nasBackupPolicies, c.nasBackupRuns, c.nasShares, c.nasAppliances, c.orgMembers,
      c.db.collection("notifications"), c.db.collection("notification_deliveries"), c.db.collection("notification_prefs")].map((col) => col.deleteMany(filter)));
    await c.orgs.deleteOne({ _id: orgId });
  }
  await (await mongoClientPromise).close();
});

test("threshold maths: 2x interval + grace", () => {
  assert.equal(staleAfterMs(60), 3 * HOUR);
  assert.equal(evaluatePolicy({ intervalMinutes: 60, lastSuccessAt: ago(2.9), updatedAt: ago(100) }, NOW), null);
  assert.ok(evaluatePolicy({ intervalMinutes: 60, lastSuccessAt: ago(3.1), updatedAt: ago(100) }, NOW));
  // An edit/re-enable restarts the clock even if the last success is old.
  assert.equal(evaluatePolicy({ intervalMinutes: 60, lastSuccessAt: ago(100), updatedAt: ago(1) }, NOW), null);
  assert.ok(EVENTS["nas.schedule_stale"]?.defaults.email && EVENTS["nas.schedule_stale"].defaults.inApp);
});

test("overdue policies alert Owners/Admins once per appliance, in-app and email", async () => {
  const sender = fakeSender();
  const r = await checkStaleNasSchedules({ now: NOW, orgIds: [orgId], sender });
  assert.equal(r.appliancesAlerted, 2, "Office NAS and Branch NAS");
  const byAppliance = Object.fromEntries(r.alerts.map((a) => [a.applianceId, a.items.map((i) => `${i.kind}:${i.shareName}`).sort()]));
  assert.deepEqual(byAppliance[String(ids.a1)], [`backup:finance-${RUN_ID}`, `snapshot:docs-${RUN_ID}`]);
  assert.deepEqual(byAppliance[String(ids.a2)], [`backup:branch-${RUN_ID}`]);
  assert.equal(byAppliance[String(ids.a3)], undefined, "healthy appliance not alerted");
  assert.equal(byAppliance[String(ids.aDel)], undefined, "deleted appliance not alerted");

  const recipients = [...new Set(sender.sent.map((m) => m.to))].sort();
  assert.deepEqual(recipients, [email("admin"), email("owner")].sort(), "only active owners/admins get email");
  assert.equal(sender.sent.length, 4, "2 appliances x 2 recipients");
  for (const m of sender.sent) assert.ok(!m.html.includes(`docs-${RUN_ID}`) && !m.subject.includes(`docs-${RUN_ID}`), "share names stay out of email");

  const feed = await c.db.collection("notifications").find({ orgId, type: "nas.schedule_stale" }).toArray();
  assert.deepEqual([...new Set(feed.map((n) => n.targetEmail))].sort(), [email("admin"), email("owner")].sort());
  assert.equal(feed.length, 4);
  assert.ok(feed.some((n) => n.body.includes(`docs-${RUN_ID}`)), "in-app body names the overdue share");

  const a1 = await c.nasAppliances.findOne({ _id: ids.a1 });
  assert.equal(a1.scheduleWatchdog.alertDay, "2026-11-17");
  assert.equal(a1.scheduleWatchdog.staleCount, 2);
});

test("a second pass the same day sends nothing; the next day alerts again", async () => {
  const sameDay = fakeSender();
  const r1 = await checkStaleNasSchedules({ now: NOW + 1 * HOUR, orgIds: [orgId], sender: sameDay });
  assert.equal(r1.appliancesAlerted, 0);
  assert.equal(r1.skippedAlreadyAlerted, 2);
  assert.equal(sameDay.sent.length, 0);

  const nextDay = fakeSender();
  const r2 = await checkStaleNasSchedules({ now: NOW + 24 * HOUR, orgIds: [orgId], sender: nextDay });
  assert.ok(r2.alerts.some((a) => a.applianceId === String(ids.a1)), "still overdue the next day -> alerted again");
  assert.ok(nextDay.sent.length >= 4);
  assert.equal((await c.nasAppliances.findOne({ _id: ids.a1 })).scheduleWatchdog.alertDay, "2026-11-18");
});
