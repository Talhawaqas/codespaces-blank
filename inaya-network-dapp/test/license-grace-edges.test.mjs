// test/license-grace-edges.test.mjs -- License Manager SOW 21.3 edge cases, deterministic clock, test database.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

delete process.env.RESEND_API_KEY;
process.env.INTEGRATION_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { getOrgCollections, ensureOrgIndexes } = await import("../src/lib/orgs.js");
const L = await import("../src/lib/licensing/service.js");
const { runLicenseJob } = await import("../src/lib/licensing/job.js");
const { effectiveState } = await import("../src/lib/licensing/state.js");
const clientPromise = (await import("../src/lib/mongodb.js")).default;

const RUN = randomBytes(3).toString("hex");
const made = [];
const ok = async () => ({ sent: true });
async function licensed(name, startDate) {
  const c = await getOrgCollections();
  const oid = (await c.orgs.insertOne({ name: `${name} ${RUN}`, createdAt: new Date().toISOString() })).insertedId; made.push(oid);
  await c.orgMembers.insertOne({ orgId: oid, email: `edge-${name.toLowerCase()}-${RUN}@example.com`, role: "owner", status: "active" });
  await L.assignLicense({ orgId: String(oid), planId: "starter", billingCycle: "monthly", currency: "USD", amount: 7.99, startDate, firstPayment: { status: "confirmed", method: "nayapay", reference: `NP-${name}-${RUN}` } });
  return String(oid);
}
before(async () => { await ensureOrgIndexes(); });
after(async () => {
  const c = await getOrgCollections();
  for (const oid of made) { await c.orgs.deleteMany({ _id: oid }); await c.orgMembers.deleteMany({ orgId: oid }); await c.db.collection("org_subscriptions").deleteMany({ orgId: oid }); await c.db.collection("billing_requests").deleteMany({ orgId: oid }); await c.db.collection("notifications").deleteMany({ orgId: oid }).catch(() => {}); }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

test("a payment confirmed just before the suspension run prevents suspension; no gap in access", async () => {
  const orgId = await licensed("Late", "2026-12-15");
  const lic = await L.getLicense(orgId);
  await runLicenseJob({ now: new Date(new Date(lic.paymentDueAt).getTime() + 1000), sender: ok, exportsStep: false, autoSuspend: true, orgIds: [orgId] });
  const p = await L.recordPayment({ orgId, amount: 7.99, currency: "USD", method: "nayapay", reference: `NP-late2-${RUN}` });
  await L.confirmPayment({ orgId, paymentId: p.paymentId });
  const r = await runLicenseJob({ now: new Date(lic.graceEndsAt), sender: ok, exportsStep: false, autoSuspend: true, orgIds: [orgId] });
  assert.equal(r.suspended, 0);
  const after = await L.getLicense(orgId);
  assert.equal(after.licenseStatus, "active");
  assert.equal(after.paidThroughDate, "2027-02-15", "extended from the 15 Jan boundary, not from the confirmation date");
});

test("a grace extension before the deadline moves the suspension; reasons are required; at most 30 days", async () => {
  const orgId = await licensed("Ext", "2026-11-01");
  const lic = await L.getLicense(orgId);
  const inGrace = new Date(new Date(lic.paymentDueAt).getTime() + 3 * 86400000);
  await runLicenseJob({ now: inGrace, sender: ok, exportsStep: false, autoSuspend: true, orgIds: [orgId] });
  await assert.rejects(L.extendGrace({ orgId, days: 5, reason: "" }), /reason/);
  await assert.rejects(L.extendGrace({ orgId, days: 31, reason: "long" }), /1 to 30/);
  const e = await L.extendGrace({ orgId, days: 5, reason: "customer travelling", now: inGrace });
  assert.equal(new Date(e.license.graceEndsAt).getTime(), new Date(lic.graceEndsAt).getTime() + 5 * 86400000);
  const r = await runLicenseJob({ now: new Date(lic.graceEndsAt), sender: ok, exportsStep: false, autoSuspend: true, orgIds: [orgId] });
  assert.equal(r.suspended, 0, "the old deadline no longer suspends");
  const r2 = await runLicenseJob({ now: new Date(e.license.graceEndsAt), sender: ok, exportsStep: false, autoSuspend: true, orgIds: [orgId] });
  assert.equal(r2.suspended, 1, "the new deadline does");
  const lifted = await L.extendGrace({ orgId, days: 3, reason: "payment on its way", now: new Date(e.license.graceEndsAt) });
  assert.equal(lifted.license.licenseStatus, "grace_period", "an extension after suspension lifts it");
});

test("dry run (automatic suspension off): the deadline passes, access stays, it is recorded once", async () => {
  const orgId = await licensed("Dry", "2026-10-01");
  const lic = await L.getLicense(orgId);
  const end = new Date(new Date(lic.graceEndsAt).getTime() + 1000);
  await runLicenseJob({ now: new Date(new Date(lic.paymentDueAt).getTime() + 1000), sender: ok, exportsStep: false, autoSuspend: false, orgIds: [orgId] });
  const r1 = await runLicenseJob({ now: end, sender: ok, exportsStep: false, autoSuspend: false, orgIds: [orgId] });
  const r2 = await runLicenseJob({ now: new Date(end.getTime() + 3600000), sender: ok, exportsStep: false, autoSuspend: false, orgIds: [orgId] });
  assert.equal(r1.suspended, 0); assert.equal(r1.dryRunSuspensions, 1); assert.equal(r2.dryRunSuspensions, 0, "recorded once");
  const now = await L.getLicense(orgId);
  assert.equal(now.licenseStatus, "grace_period");
  assert.equal(effectiveState(now, end, { autoSuspend: false }).access, "normal");
});

test("a failed notice is retried by the next run, and not sent again once delivered", async () => {
  const orgId = await licensed("Retry", "2026-09-01");
  const lic = await L.getLicense(orgId);
  const t = new Date(new Date(lic.paymentDueAt).getTime() + 1000);
  let calls = 0; const flaky = async () => (++calls === 1 ? { sent: false, reason: "provider_error" } : { sent: true });
  await runLicenseJob({ now: t, sender: flaky, exportsStep: false, autoSuspend: true, orgIds: [orgId] });
  const { ledger } = await L.licenseCollections();
  const rowAfterFail = await ledger.findOne({ kind: "license_notice", licenseId: lic.licenseId, noticeType: "grace_started" });
  assert.equal(rowAfterFail.noticeStatus, "failed", "the failure is recorded and visible to the admin");
  // The grace start is a state change, so a retry happens through the next reminder run of the same notice.
  const { sendLicenseNotice } = await import("../src/lib/licensing/notices.js");
  const again = await sendLicenseNotice({ orgId, type: "grace_started", license: await L.getLicense(orgId), now: t, sender: flaky });
  assert.equal(again.sent, true);
  const third = await sendLicenseNotice({ orgId, type: "grace_started", license: await L.getLicense(orgId), now: t, sender: flaky });
  assert.equal(third.skipped, true, "delivered once; never again");
  assert.equal(calls, 2);
});
