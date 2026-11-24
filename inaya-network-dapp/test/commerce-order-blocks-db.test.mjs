// Order blocks against the test database: planLimits() raises the synced-order limit by 1,000 per block,
// top-ups count only in their own UTC month, Enterprise stays unlimited.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { planLimits } from "../src/lib/online/stores.js";
import { orderMonthKey } from "../src/lib/commercePricing.js";

const ids = { starter: new ObjectId(), biz: new ObjectId(), ent: new ObjectId(), old: new ObjectId() };
let c;
before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertMany([
    { _id: ids.starter, name: "ob starter", plan: "professional", commerceOrderBlocks: 1, commerceOrderTopups: { [orderMonthKey()]: 1 }, createdAt: now },
    { _id: ids.biz, name: "ob business", plan: "business", createdAt: now },
    { _id: ids.ent, name: "ob enterprise", plan: "enterprise", commerceOrderBlocks: 3, createdAt: now },
    { _id: ids.old, name: "ob last month", plan: "business", commerceOrderTopups: { "2000-01": 3 }, createdAt: now },
  ]);
});
after(async () => { await c.orgs.deleteMany({ _id: { $in: Object.values(ids) } }); await (await mongoClientPromise).close(); });

test("Commerce Starter 300 + 1 monthly block + 1 top-up = 2,300", async () => {
  const l = await planLimits(String(ids.starter));
  assert.equal(l.baseMonthlyOrders, 300); assert.equal(l.monthlyOrders, 2300); assert.equal(l.orderBlocks.blocks, 2);
});
test("Commerce add-on without blocks keeps 1,000", async () => {
  const l = await planLimits(String(ids.biz)); assert.equal(l.monthlyOrders, 1000); assert.equal(l.orderBlocks.blocks, 0); assert.equal(l.orderBlocks.eligible, true);
});
test("Enterprise stays unlimited; stored blocks are ignored", async () => {
  const l = await planLimits(String(ids.ent)); assert.equal(l.monthlyOrders, null); assert.equal(l.orderBlocks.eligible, false);
});
test("an old month's top-up adds nothing now", async () => {
  assert.equal((await planLimits(String(ids.old))).monthlyOrders, 1000);
});
