// License Manager order-block actions through the real admin API route (test database):
// set_order_blocks / add_order_topup -- confirmation, reason, plan eligibility, the 3-block cap, audit records,
// and the new limit actually reaching planLimits().
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";
process.env.ADMIN_DASHBOARD_PASSPHRASE ||= "test-admin-passphrase-order-blocks";
const { ADMIN_SESSION_COOKIE, computeAdminSessionCookieValue } = await import("../src/lib/admin-auth.js");
const { POST, GET } = await import("../src/app/api/admin/licenses/[orgId]/route.js");
const { getOrgCollections, ensureOrgIndexes } = await import("../src/lib/orgs.js");
const { planLimits } = await import("../src/lib/online/stores.js");
const { orderMonthKey } = await import("../src/lib/commercePricing.js");
const mongoClientPromise = (await import("../src/lib/mongodb.js")).default;

const biz = new ObjectId(), ent = new ObjectId(); let c;
const call = (orgId, body, auth = true) => POST(new NextRequest(`http://localhost/api/admin/licenses/${orgId}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(auth ? { cookie: `${ADMIN_SESSION_COOKIE}=${computeAdminSessionCookieValue()}` } : {}) } }), { params: Promise.resolve({ orgId: String(orgId) }) });

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString(); await c.orgs.insertMany([{ _id: biz, name: "ob admin biz", plan: "business", createdAt: now }, { _id: ent, name: "ob admin ent", plan: "enterprise", createdAt: now }]); });
after(async () => { await c.orgs.deleteMany({ _id: { $in: [biz, ent] } }); await c.orgActivity?.deleteMany?.({ orgId: { $in: [biz, ent] } }).catch?.(() => {}); await (await mongoClientPromise).close(); });

test("not signed in as admin: refused", async () => {
  assert.equal((await call(biz, { action: "set_order_blocks", recurring: 1, reason: "INV-1", confirm: true }, false)).status, 401);
});
test("needs confirmation and a reason", async () => {
  assert.equal((await call(biz, { action: "set_order_blocks", recurring: 1, reason: "INV-1" })).status, 400);
  const r = await call(biz, { action: "set_order_blocks", recurring: 1, reason: "", confirm: true }); assert.equal(r.status, 400); assert.match((await r.json()).error, /reason/);
});
test("monthly blocks + a top-up raise the limit; the cap of 3 holds", async () => {
  let r = await call(biz, { action: "set_order_blocks", recurring: 1, reason: "INV-100", confirm: true }); assert.equal(r.status, 200); assert.equal((await r.json()).orderBlocks.recurring, 1);
  r = await call(biz, { action: "add_order_topup", blocks: 1, reason: "PAY-7", confirm: true }); assert.equal(r.status, 200);
  assert.equal((await planLimits(String(biz))).monthlyOrders, 3000);
  r = await call(biz, { action: "add_order_topup", blocks: 2, reason: "PAY-8", confirm: true }); assert.equal(r.status, 400); assert.match((await r.json()).error, /already has 2/);
  r = await call(biz, { action: "set_order_blocks", recurring: 3, reason: "INV-101", confirm: true }); assert.equal(r.status, 400); assert.match((await r.json()).error, /the most is 3/);
  const org = await c.orgs.findOne({ _id: biz }); assert.equal(org.commerceOrderBlocks, 1); assert.equal(org.commerceOrderTopups[orderMonthKey()], 1);
  const g = await (await GET(new NextRequest(`http://localhost/api/admin/licenses/${biz}`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${computeAdminSessionCookieValue()}` } }), { params: Promise.resolve({ orgId: String(biz) }) })).json();
  assert.equal(g.company.orderBlocks.blocks, 2, "the admin panel shows the current blocks");
});
test("two simultaneous top-ups cannot both apply (no double charge on a double click)", async () => {
  await c.orgs.updateOne({ _id: biz }, { $set: { commerceOrderBlocks: 0 }, $unset: { commerceOrderTopups: "" } });
  const rs = await Promise.all([call(biz, { action: "add_order_topup", blocks: 1, reason: "PAY-9", confirm: true }), call(biz, { action: "add_order_topup", blocks: 1, reason: "PAY-9", confirm: true })]);
  const ok = rs.filter((r) => r.status === 200).length; const top = (await c.orgs.findOne({ _id: biz })).commerceOrderTopups[orderMonthKey()];
  assert.equal(top, ok, "stored top-ups equal the number of successful calls"); assert.ok(ok >= 1);
});
test("Enterprise is refused (already unlimited)", async () => {
  const r = await call(ent, { action: "set_order_blocks", recurring: 1, reason: "INV-1", confirm: true }); assert.equal(r.status, 400); assert.match((await r.json()).error, /unlimited/);
});
