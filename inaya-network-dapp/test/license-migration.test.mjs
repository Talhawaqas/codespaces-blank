// test/license-migration.test.mjs -- License Manager SOW 20: adopting pre-license subscriptions and bulk assignment.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

delete process.env.RESEND_API_KEY;
const { getOrgCollections, ensureOrgIndexes } = await import("../src/lib/orgs.js");
const L = await import("../src/lib/licensing/service.js");
const { listBillingRequests } = await import("../src/lib/billingRequests.js");
const clientPromise = (await import("../src/lib/mongodb.js")).default;
const RUN = randomBytes(3).toString("hex");
const made = [];
async function org(name) { const c = await getOrgCollections(); const id = (await c.orgs.insertOne({ name: `${name} ${RUN}`, createdAt: new Date().toISOString() })).insertedId; made.push(id); return id; }
before(async () => { await ensureOrgIndexes(); });
after(async () => {
  const c = await getOrgCollections();
  for (const oid of made) { await c.orgs.deleteMany({ _id: oid }); await c.db.collection("org_subscriptions").deleteMany({ orgId: oid }); await c.db.collection("billing_requests").deleteMany({ orgId: oid }); }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

test("a pre-license paid subscription is adopted as an active license, keeping its paid-through date; no payment is inferred", async () => {
  const oid = await org("Legacy");
  const { db } = await getOrgCollections();
  await db.collection("org_subscriptions").insertOne({ orgId: oid, plan: "business", status: "active", provider: "bank_transfer", currency: "PKR", billingInterval: "month", pilot: true, currentPeriodEnd: "2027-03-14T19:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
  await db.collection("billing_requests").insertOne({ orgId: oid, planId: "business", interval: "month", currency: "PKR", amountPkr: 21000, status: "active", activatedAt: "2026-11-01T00:00:00.000Z", requestedAt: "2026-10-30T00:00:00.000Z" });
  assert.ok((await L.legacySubscriptions()).some((r) => r.orgId === String(oid)));
  const r = await L.adoptLegacySubscription({ orgId: String(oid) });
  assert.equal(r.adopted, true);
  assert.equal(r.license.licenseStatus, "active");
  assert.equal(r.license.amount, 21000, "the pilot price from the activation request is kept");
  assert.equal(r.license.paidThroughDate, "2027-03-15", "paid through the existing period end (PKT billing date)");
  assert.equal((await L.licenseHistory(String(oid))).payments.length, 0, "no payment invented");
  assert.equal((await L.adoptLegacySubscription({ orgId: String(oid) })).adopted, false, "idempotent");
  assert.ok((await listBillingRequests()).every((x) => x.planId !== undefined || x.status !== undefined), "activation request list is unaffected by license rows");
});

test("bulk assignment: preview validates every row and changes nothing; assigning is per-row, idempotent and never confirms payment", async () => {
  const a = await org("BulkA"); const b = await org("BulkB");
  const rows = [
    { orgId: String(a), planId: "starter", billingCycle: "monthly", currency: "USD", amount: 7.99, startDate: "2027-01-01" },
    { orgId: String(b), planId: "professional", billingCycle: "yearly", currency: "PKR", amount: 200000, startDate: "2027-01-01" },
    { orgId: String(a), planId: "starter", billingCycle: "monthly", currency: "USD", amount: 7.99, startDate: "2027-01-01" },
    { orgId: "nope", planId: "starter", billingCycle: "monthly", currency: "USD", amount: 1, startDate: "2027-01-01" },
    { orgId: String(b).replace(/.$/, "0"), planId: "gold", billingCycle: "monthly", currency: "USD", amount: 1, startDate: "2027-01-01" },
  ];
  const p = await L.bulkAssign({ rows, preview: true });
  assert.deepEqual(p.results.map((x) => x.status), ["valid", "valid", "error", "error", "error"]);
  assert.equal(await L.getLicense(String(a)), null, "preview changed nothing");
  const done = await L.bulkAssign({ rows: rows.slice(0, 2), preview: false });
  assert.deepEqual(done.results.map((x) => x.status), ["assigned", "assigned"]);
  assert.equal((await L.getLicense(String(a))).licenseStatus, "pending_activation", "awaiting the first payment");
  const again = await L.bulkAssign({ rows: rows.slice(0, 2), preview: false });
  assert.deepEqual(again.results.map((x) => x.status), ["skipped", "skipped"], "running it twice assigns nothing new");
});
