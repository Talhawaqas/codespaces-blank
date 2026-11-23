// test/license-lifecycle.test.mjs -- License Manager SOW 21.2 - 21.4 against the TEST database, with throwaway companies.
// Covers: assignment, payments, renewals, grace (deterministic clock), suspension, recovery, corrections, plan/cycle
// changes, the central gate (tenant isolation, member vs owner, restricted paths), notices (no duplicates), exports and
// the Excel workbook. No real e-mail is sent (RESEND_API_KEY is removed; notices use a recording sender).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";

delete process.env.RESEND_API_KEY; // never e-mail anyone from a test
process.env.INTEGRATION_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
process.env.LICENSE_AUTO_SUSPEND = "on";

const { getOrgCollections, ensureOrgIndexes, createSession, requireMembership } = await import("../src/lib/orgs.js");
const L = await import("../src/lib/licensing/service.js");
const { runLicenseJob } = await import("../src/lib/licensing/job.js");
const { licenseGate, companyMayOperate, invalidateLicenseCache } = await import("../src/lib/licensing/gate.js");
const { paymentDueAt, graceEndsAt, addCycles } = await import("../src/lib/licensing/dates.js");
const { effectiveState } = await import("../src/lib/licensing/state.js");
const { listLicenses, licenseSummary, buildLicenseWorkbook } = await import("../src/lib/licensing/admin.js");
const { setChunkedObjectBackendForTests } = await import("../src/lib/chunkedStorage.js");
const X = await import("../src/lib/licensing/exports.js");
const { ensureOwnerS3Passphrase } = await import("../src/lib/s3-compat/credentials.js");
const clientPromise = (await import("../src/lib/mongodb.js")).default;

const RUN = randomBytes(3).toString("hex");
const made = [];
const sent = [];
// The job runs over every license in the test database (other suites or a browser walkthrough may have their own),
// so only notices to this run's companies are recorded.
const sender = async ({ to, subject }) => { if (String(to).includes(RUN)) sent.push({ to, subject }); return { sent: true }; };
const bucket = new Map();
const memory = { put: async (k, b) => { bucket.set(k, new Uint8Array(b)); return `bafy${bucket.size}`; }, get: async (k) => bucket.get(k), deletePrefix: async (p) => { let n = 0; for (const k of [...bucket.keys()]) if (k.startsWith(p)) { bucket.delete(k); n++; } return { deleted: n }; } };

async function company(name) {
  const c = await getOrgCollections();
  const orgId = (await c.orgs.insertOne({ name: `${name} ${RUN}`, createdAt: new Date().toISOString(), requiresPlanSelection: true })).insertedId;
  made.push(orgId);
  const people = {};
  for (const role of ["owner", "admin", "member"]) {
    const email = `lic-${role}-${RUN}-${name.toLowerCase().replace(/\W/g, "")}@example.com`;
    await c.orgMembers.insertOne({ orgId, email, role, status: "active", joinedAt: new Date().toISOString() });
    people[role] = { email, token: (await createSession(email)).sessionToken };
  }
  return { orgId: String(orgId), oid: orgId, people };
}
const { inflateRawSync } = await import("node:zlib");
/** Reads one entry of a ZIP (the workbook) by walking its local file headers. */
function unzipEntry(buf, name) {
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8), csize = buf.readUInt32LE(i + 18), nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    const n = buf.subarray(i + 30, i + 30 + nlen).toString("utf8"); const start = i + 30 + nlen + xlen; const data = buf.subarray(start, start + csize);
    if (n === name) return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    i = start + csize;
  }
  return "";
}
const req = (path, who, method = "GET") => new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${who.token}` } });

let A; let B;
before(async () => {
  await ensureOrgIndexes();
  setChunkedObjectBackendForTests(memory);
  A = await company("Acme"); B = await company("Beta");
});
after(async () => {
  setChunkedObjectBackendForTests(null);
  const c = await getOrgCollections();
  for (const oid of made) {
    await c.orgs.deleteMany({ _id: oid }); await c.orgMembers.deleteMany({ orgId: oid }); await c.db.collection("org_subscriptions").deleteMany({ orgId: oid });
    await c.db.collection("billing_requests").deleteMany({ orgId: oid }); await c.db.collection("org_activity").deleteMany({ orgId: oid }).catch(() => {});
    await c.db.collection("notifications").deleteMany({ orgId: oid }).catch(() => {}); await c.db.collection("s3_owner_keys").deleteMany({ ownerId: String(oid) }).catch(() => {});
  }
  await c.sessions.deleteMany({ email: { $regex: `-${RUN}-` } }).catch(() => {});
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

test("assign: monthly license awaits its first payment; duplicates, unknown companies and bad input are refused", async () => {
  const r = await L.assignLicense({ orgId: A.orgId, planId: "professional", billingCycle: "monthly", currency: "USD", amount: 39, startDate: "2027-01-01", firstPayment: { status: "awaiting" }, note: "internal: pilot convert" });
  assert.equal(r.license.licenseStatus, "pending_activation", "not active before payment (decision 2)");
  assert.equal(r.license.planSnapshot.name, "Professional");
  await assert.rejects(L.assignLicense({ orgId: A.orgId, planId: "business", billingCycle: "monthly", currency: "USD", amount: 99, startDate: "2027-01-01", firstPayment: { status: "awaiting" } }), /already has a license/);
  await assert.rejects(L.assignLicense({ orgId: String(new ObjectId()), planId: "business", billingCycle: "monthly", currency: "USD", amount: 99, startDate: "2027-01-01", firstPayment: { status: "awaiting" } }), /No company/);
  await assert.rejects(L.assignLicense({ orgId: B.orgId, planId: "platinum", billingCycle: "monthly", currency: "USD", amount: 1, startDate: "2027-01-01", firstPayment: { status: "awaiting" } }), /Unknown/);
  await assert.rejects(L.assignLicense({ orgId: B.orgId, planId: "business", billingCycle: "weekly", currency: "USD", amount: 1, startDate: "2027-01-01", firstPayment: { status: "awaiting" } }), /monthly or yearly/);
  await assert.rejects(L.assignLicense({ orgId: B.orgId, planId: "business", billingCycle: "monthly", currency: "USD", amount: 99, startDate: "2027-01-01" }), /already paid or awaiting/);
});

test("payments: pending changes nothing; confirming activates; confirm is idempotent; a reused reference is refused", async () => {
  const p = await L.recordPayment({ orgId: A.orgId, amount: 39, currency: "USD", method: "nayapay", reference: `NP-${RUN}-1` });
  assert.equal((await L.getLicense(A.orgId)).licenseStatus, "pending_activation", "a pending payment is not a confirmed one");
  const c = await L.confirmPayment({ orgId: A.orgId, paymentId: p.paymentId });
  assert.equal(c.license.licenseStatus, "active");
  assert.equal(c.license.paidThroughDate, "2027-02-01");
  assert.equal(c.license.paymentDueAt, paymentDueAt("2027-02-01").toISOString());
  assert.equal(c.license.graceEndsAt, graceEndsAt("2027-02-01").toISOString());
  assert.equal((await L.confirmPayment({ orgId: A.orgId, paymentId: p.paymentId })).replayed, true, "confirming twice renews once");
  assert.equal((await L.getLicense(A.orgId)).paidThroughDate, "2027-02-01");
  const dup = await L.recordPayment({ orgId: A.orgId, amount: 39, currency: "USD", method: "nayapay", reference: `NP-${RUN}-1` });
  await assert.rejects(L.confirmPayment({ orgId: A.orgId, paymentId: dup.paymentId }), /already exists/);
  await L.rejectPayment({ orgId: A.orgId, paymentId: dup.paymentId, reason: "duplicate of NP-1" });
  const wrong = await L.recordPayment({ orgId: A.orgId, amount: 20, currency: "USD", method: "bank_transfer", reference: `BT-${RUN}-x` });
  await assert.rejects(L.confirmPayment({ orgId: A.orgId, paymentId: wrong.paymentId }), /Expected 39/);
  await L.rejectPayment({ orgId: A.orgId, paymentId: wrong.paymentId, reason: "short payment" });
  await assert.rejects(L.recordPayment({ orgId: A.orgId, amount: 39, currency: "PKR", method: "nayapay", reference: "x123" }), /billed in USD/);
  const { db } = await getOrgCollections();
  assert.equal((await db.collection("orgs").findOne({ _id: A.oid })).plan, "professional", "the plan the existing entitlement checks read");
});

test("yearly license with the first payment recorded at assignment; renewal before the due date extends from paid-through", async () => {
  const r = await L.assignLicense({ orgId: B.orgId, planId: "business", billingCycle: "yearly", currency: "PKR", amount: 300000, startDate: "2027-01-31", firstPayment: { status: "confirmed", method: "bank_transfer", reference: `BT-${RUN}-B1` } });
  assert.equal(r.license.licenseStatus, "active");
  assert.equal(r.license.paidThroughDate, "2028-01-31");
  const p = await L.recordPayment({ orgId: B.orgId, amount: 300000, currency: "PKR", method: "bank_transfer", reference: `BT-${RUN}-B2` });
  assert.equal(L.previewRenewal(await L.getLicense(B.orgId)).newPaidThroughDate, "2029-01-31", "preview shows the effective dates first");
  const c = await L.confirmPayment({ orgId: B.orgId, paymentId: p.paymentId });
  assert.equal(c.license.paidThroughDate, "2029-01-31", "no lost days, no free days (decision 3)");
});

test("grace period with a deterministic clock: start, a reminder every day (e-mail + in-app), no duplicates, suspension at the deadline", async () => {
  const due = new Date((await L.getLicense(A.orgId)).paymentDueAt);
  const at = (days, ms = 0) => new Date(due.getTime() + days * 86400000 + ms);
  sent.length = 0;
  let r = await runLicenseJob({ now: new Date(due.getTime() - 3 * 86400000), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  assert.equal(r.dueSoonNotices, 1, "payment-due notice a few days before");
  r = await runLicenseJob({ now: new Date(due.getTime() - 1), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  assert.equal(r.graceStarted, 0, "no early grace");
  r = await runLicenseJob({ now: at(0, 1000), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  assert.equal(r.graceStarted, 1);
  const lic = await L.getLicense(A.orgId);
  assert.equal(lic.licenseStatus, "grace_period"); assert.equal(lic.graceStartedAt, lic.paymentDueAt, "grace starts at the due instant, not the job's run time");
  r = await runLicenseJob({ now: at(0, 2000), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  assert.equal(r.graceStarted, 0, "a second run changes nothing");
  assert.equal(sent.filter((s) => /overdue/i.test(s.subject)).length, 2, "one grace-start notice per Owner and Admin, not repeated");
  // A reminder every day of grace (founder, 17 Nov 2026), e-mail + in-app, never twice on the same day.
  for (let d = 1; d <= 13; d++) {
    await runLicenseJob({ now: at(d, 60000), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
    await runLicenseJob({ now: at(d, 120000), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  }
  const daily = sent.filter((s) => /remaining until your Business OS license is suspended/.test(s.subject));
  assert.equal(daily.length, 13 * 2, "one reminder a day for days 1-13, to both billing contacts, none repeated");
  assert.ok(daily.some((s) => /: 13 days remaining/.test(s.subject)) && daily.some((s) => /: 7 days remaining/.test(s.subject)), "counts down");
  assert.equal(daily.filter((s) => /: 1 day remaining/.test(s.subject)).length, 2, "the final day says 1 day remaining");
  const inApp = await (await getOrgCollections()).db.collection("notifications").countDocuments({ orgId: A.oid, type: "billing.license" });
  assert.ok(inApp >= 14, `in-app notices too (found ${inApp})`);
  r = await runLicenseJob({ now: new Date(new Date(lic.graceEndsAt).getTime() - 60000), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  assert.equal(r.suspended, 0, "not one minute early");
  assert.equal(effectiveState(await L.getLicense(A.orgId), new Date(new Date(lic.graceEndsAt).getTime() - 60000)).access, "normal", "normal access through grace");
  r = await runLicenseJob({ now: new Date(lic.graceEndsAt), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  assert.equal(r.suspended, 1, "suspended exactly at the deadline");
  r = await runLicenseJob({ now: new Date(new Date(lic.graceEndsAt).getTime() + 3600000), sender, exportsStep: false, orgIds: [A.orgId, B.orgId] });
  assert.equal(r.suspended, 0, "no duplicate suspension");
  assert.equal(sent.filter((s) => /Business OS license suspended$/.test(s.subject)).length, 2, "one suspension notice per billing contact");
  const s = await L.getLicense(A.orgId);
  assert.equal(s.licenseStatus, "suspended"); assert.equal(s.suspendedReason, "grace_ended");
  const { db } = await getOrgCollections();
  assert.ok(await db.collection("orgs").findOne({ _id: A.oid }), "suspension deletes nothing");
});

test("the gate: a suspended company keeps Billing, license, export and document download for Owners/Admins only", async () => {
  invalidateLicenseCache(A.orgId);
  const now = new Date();
  assert.equal(await companyMayOperate(A.orgId, now), false);
  const blocked = await requireMembership(req(`/api/orgs/crm/contacts?orgId=${A.orgId}`, A.people.owner), A.orgId);
  assert.equal(blocked.status, 403); assert.equal(blocked.code, "LICENSE_RESTRICTED");
  for (const [path, method] of [["/api/orgs/billing", "GET"], ["/api/orgs/license", "GET"], ["/api/orgs/exports", "POST"], [`/api/orgs/exports/${new ObjectId()}/download`, "GET"], [`/api/orgs/documents/${new ObjectId()}/retrieve`, "GET"], ["/api/orgs/session", "GET"]]) {
    const ok = await requireMembership(req(`${path}?orgId=${A.orgId}`, A.people.admin, method), A.orgId);
    assert.ok(!ok.error, `${method} ${path} stays open for an admin`);
  }
  assert.equal((await requireMembership(req(`/api/orgs/billing?orgId=${A.orgId}`, A.people.member), A.orgId)).status, 403, "members do not get Billing");
  assert.ok(!(await requireMembership(req(`/api/orgs/license/status?orgId=${A.orgId}`, A.people.member), A.orgId)).error, "members get the neutral status notice");
  assert.equal((await requireMembership(req(`/api/orgs/documents/x/retrieve?orgId=${A.orgId}`, A.people.member), A.orgId)).status, 403);
  assert.equal((await requireMembership(req(`/api/orgs/documents?orgId=${A.orgId}`, A.people.owner, "POST"), A.orgId)).status, 403, "no uploads while suspended");
  // Tenant isolation: Company B is active and unaffected; A's people cannot reach B, and B's cannot reach A's billing.
  assert.equal(await companyMayOperate(B.orgId), true);
  assert.ok(!(await requireMembership(req(`/api/orgs/crm/contacts?orgId=${B.orgId}`, B.people.member), B.orgId)).error);
  assert.equal((await requireMembership(req(`/api/orgs/license?orgId=${B.orgId}`, A.people.owner), B.orgId)).status, 403, "not a member of B");
  assert.equal((await requireMembership(req(`/api/orgs/license?orgId=${A.orgId}`, B.people.owner), A.orgId)).status, 403, "not a member of A");
  assert.equal(await licenseGate(req("/api/orgs/ai/chat", A.people.owner, "POST"), A.orgId, { isManager: true }).then((g) => g?.code), "LICENSE_RESTRICTED", "AI endpoints are gated too");
});

test("recovery: payment after suspension reactivates from the previous boundary (no free period); export works throughout", async () => {
  const before = await L.getLicense(A.orgId);
  const p = await L.recordPayment({ orgId: A.orgId, amount: 39, currency: "USD", method: "bank_transfer", reference: `BT-${RUN}-late` });
  const c = await L.confirmPayment({ orgId: A.orgId, paymentId: p.paymentId });
  assert.equal(c.license.licenseStatus, "active");
  assert.equal(c.license.paidThroughDate, addCycles(before.paidThroughDate, "monthly", 1, before.anchorDay), "extends from the missed boundary");
  invalidateLicenseCache(A.orgId);
  const history = await L.licenseHistory(A.orgId);
  for (const t of ["license_assigned", "payment_confirmed", "license_activated", "grace_started", "license_suspended", "license_reactivated", "payment_rejected"]) assert.ok(history.events.some((e) => e.eventType === t), `audit event ${t}`);
});

test("corrections and changes: reversal of the latest renewal reverts the date; plan/cycle changes keep history; extension, manual suspension, override, cancellation", async () => {
  const before = await L.getLicense(B.orgId);
  const pay = (await L.licenseHistory(B.orgId)).payments.find((p) => p.reference === `BT-${RUN}-B2`);
  await assert.rejects(L.reversePayment({ orgId: B.orgId, paymentId: String(pay._id), reason: "" }), /reason/);
  const rv = await L.reversePayment({ orgId: B.orgId, paymentId: String(pay._id), reason: "bank returned the transfer" });
  assert.match(rv.impact, /2028-01-31/);
  const after = await L.getLicense(B.orgId);
  assert.equal(after.paidThroughDate, "2028-01-31"); assert.notEqual(after.paidThroughDate, before.paidThroughDate);
  const hist = await L.licenseHistory(B.orgId);
  assert.ok(hist.payments.some((p) => p.paymentStatus === "reversed") && hist.payments.some((p) => p.paymentStatus === "reversal"), "original kept, reversal appended");

  await assert.rejects(L.changeSubscription({ orgId: B.orgId, billingCycle: "monthly", reason: "customer asked" }), /agreed amount/);
  await L.changeSubscription({ orgId: B.orgId, planId: "enterprise", amount: 600000, applyAt: "now", reason: "upgrade agreed by phone" });
  assert.equal((await L.getLicense(B.orgId)).planSnapshot.name, "Enterprise");
  await L.changeSubscription({ orgId: B.orgId, billingCycle: "monthly", amount: 60000, applyAt: "next_renewal", reason: "switch to monthly from next renewal" });
  assert.equal((await L.getLicense(B.orgId)).billingCycle, "yearly", "applies at the next renewal");
  assert.ok((await L.licenseHistory(B.orgId)).periods.length >= 3, "every version kept");

  await assert.rejects(L.extendGrace({ orgId: B.orgId, days: 5, reason: "asked" }), /overdue/);
  const s = await L.suspendLicense({ orgId: B.orgId, reason: "fraud review" });
  assert.equal(s.license.licenseStatus, "suspended");
  const ov = await L.reactivateLicense({ orgId: B.orgId, reason: "review cleared", untilDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) });
  assert.equal(effectiveState(ov.license).state, "admin_override");
  await assert.rejects(L.reactivateLicense({ orgId: B.orgId, reason: "x long", untilDate: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) }), /at most/);
  const cancel = await L.cancelLicense({ orgId: B.orgId, reason: "customer leaving" });
  assert.equal(effectiveState(cancel.license).access, "normal", "access continues to the paid-through date (decision 6)");
  invalidateLicenseCache(B.orgId);
});

test("company data export: queued, built (records + files + manifest), downloadable by the same company only, expires", async () => {
  // No ensureOwnerS3Passphrase here on purpose: a company that never used S3 storage must still be able to export.
  const { job } = await X.requestExport({ orgId: A.orgId, email: A.people.owner.email });
  assert.equal(job.status, "queued");
  assert.equal((await X.requestExport({ orgId: A.orgId, email: A.people.owner.email })).existing, true, "one at a time");
  assert.equal((await X.processExportJob(job.id)).ready, true);
  const dl = await X.readExportForDownload({ orgId: A.orgId, exportId: job.id, email: A.people.owner.email });
  const text = dl.buffer.toString("latin1");
  for (const name of ["README.txt", "export-manifest.json", "company.json", "records/org_subscriptions.json", "documents-encrypted.json"]) assert.ok(text.includes(name), `zip has ${name}`);
  assert.ok(!text.includes("internal: pilot convert"), "Inaya's internal notes are not exported");
  await assert.rejects(X.readExportForDownload({ orgId: B.orgId, exportId: job.id, email: B.people.owner.email }), /not found/i, "another company cannot download it");
  const ex = await X.expireExportArtifacts({ now: new Date(Date.now() + 8 * 86400000) });
  assert.ok(ex.expired >= 1);
  await assert.rejects(X.readExportForDownload({ orgId: A.orgId, exportId: job.id, email: A.people.owner.email }), /expired/);
});

test("License Manager list, summary and a real four-sheet workbook with formula injection neutralised", async () => {
  const { db } = await getOrgCollections();
  await db.collection("orgs").updateOne({ _id: A.oid }, { $set: { name: `=HYPERLINK("http://x") ${RUN}` } });
  const list = await listLicenses({ q: RUN });
  assert.equal(list.total, 2);
  const sum = await licenseSummary({ q: RUN });
  assert.equal(sum.total, 2);
  const wb = await buildLicenseWorkbook({ q: RUN });
  assert.equal(wb.buffer.subarray(0, 2).toString("latin1"), "PK", "a real .xlsx (zip) file, not a renamed CSV");
  const workbook = unzipEntry(wb.buffer, "xl/workbook.xml");
  for (const s of ["License Register", "Payment History", "License Activity", "Summary", "About"]) assert.ok(workbook.includes(`name="${s}"`), `sheet ${s}`);
  const register = unzipEntry(wb.buffer, "xl/worksheets/sheet1.xml");
  assert.ok(register.includes("'=HYPERLINK"), "a company name starting with = is stored as text, never a formula");
  assert.ok(!register.includes("<f>"), "no formulas at all");
  assert.ok(wb.counts.payments >= 4 && wb.counts.events >= 10);
});
