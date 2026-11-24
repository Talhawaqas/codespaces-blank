// Extra 1,000-order blocks (owner-approved 24 Nov 2026): $15 / PKR 2,500, recurring or one-month top-up,
// Commerce Starter (professional) + Commerce add-on (business) only, at most 3 blocks a month.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMERCE_PRICING, orderBlockAllowance, checkOrderBlockChange, orderMonthKey } from "../src/lib/commercePricing.js";

const NOV = new Date("2026-11-24T10:00:00Z");
const DEC = new Date("2026-12-01T00:00:01Z");

test("approved price, size, plans and cap", () => {
  assert.deepEqual(COMMERCE_PRICING.orderBlock, { usd: 15, pkr: 2500, orders: 1000, maxBlocks: 3, plans: ["professional", "business"] });
});

test("no blocks: no extra orders; enterprise and unknown plans are never eligible", () => {
  assert.equal(orderBlockAllowance({ plan: "business" }, NOV).extraOrders, 0);
  assert.equal(orderBlockAllowance({ plan: "enterprise", commerceOrderBlocks: 2 }, NOV).eligible, false);
  assert.equal(orderBlockAllowance({ plan: "enterprise", commerceOrderBlocks: 2 }, NOV).extraOrders, 0);
  assert.equal(orderBlockAllowance(null, NOV).extraOrders, 0);
});

test("recurring + this month's top-up add 1,000 each; top-ups expire with the UTC month", () => {
  const org = { plan: "professional", commerceOrderBlocks: 1, commerceOrderTopups: { "2026-11": 1 } };
  assert.deepEqual(orderBlockAllowance(org, NOV), { eligible: true, recurring: 1, topup: 1, blocks: 2, extraOrders: 2000, maxBlocks: 3 });
  assert.equal(orderBlockAllowance(org, DEC).extraOrders, 1000, "November top-up no longer counts in December");
  assert.equal(orderMonthKey(NOV), "2026-11");
});

test("never more than 3 blocks, whatever is stored; junk values count as zero", () => {
  assert.equal(orderBlockAllowance({ plan: "business", commerceOrderBlocks: 9, commerceOrderTopups: { "2026-11": 9 } }, NOV).blocks, 3);
  assert.equal(orderBlockAllowance({ plan: "business", commerceOrderBlocks: 2, commerceOrderTopups: { "2026-11": 5 } }, NOV).blocks, 3);
  assert.equal(orderBlockAllowance({ plan: "business", commerceOrderBlocks: -4, commerceOrderTopups: { "2026-11": "x" } }, NOV).blocks, 0);
  assert.equal(orderBlockAllowance({ plan: "business", commerceOrderBlocks: 1.9 }, NOV).blocks, 1);
});

test("admin change validation", () => {
  assert.match(checkOrderBlockChange({ plan: "enterprise" }, { recurring: 1 }, NOV), /unlimited/);
  assert.match(checkOrderBlockChange({ plan: "starter" }, { recurring: 1 }, NOV), /Commerce Starter/);
  assert.equal(checkOrderBlockChange({ plan: "business" }, { recurring: 3 }, NOV), null);
  assert.match(checkOrderBlockChange({ plan: "business" }, { recurring: 4 }, NOV), /0 to 3/);
  assert.match(checkOrderBlockChange({ plan: "business" }, { recurring: 1.5 }, NOV), /whole number/);
  assert.match(checkOrderBlockChange({ plan: "business", commerceOrderTopups: { "2026-11": 2 } }, { recurring: 2 }, NOV), /the most is 3/);
  assert.equal(checkOrderBlockChange({ plan: "professional", commerceOrderBlocks: 2 }, { addTopup: 1 }, NOV), null);
  assert.match(checkOrderBlockChange({ plan: "professional", commerceOrderBlocks: 2 }, { addTopup: 2 }, NOV), /already has 2/);
  assert.match(checkOrderBlockChange({ plan: "professional" }, { addTopup: 0 }, NOV), /at least one/);
});
