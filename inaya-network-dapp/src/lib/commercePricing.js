// src/lib/commercePricing.js -- Inaya Commerce prices (owner APPROVED 23 Nov 2026). One source for the pricing page,
// the plan limits and the documents. Monthly prices; annual = 10x monthly (two months free), as for the base plans.
//   Commerce Starter  -- add-on to Professional: 1 branch, 1 till, own web store, ONE connected store (Shopify OR WooCommerce), 300 online orders a month
//   Commerce add-on   -- add-on to Business: 2 branches, 3 tills, own web store, 1 Shopify + 1 WooCommerce, 1,000 online orders a month
//   Business + Commerce bundle -- the Business plan with the Commerce add-on at a saving
//   Enterprise        -- Commerce INCLUDED: unlimited branches and tills, 3 connected stores, unlimited orders
//   Extras            -- extra branch / extra till, monthly
//   Extra order block -- (owner APPROVED 24 Nov 2026) +1,000 synced online orders a month for $15 / PKR 2,500, sold as a
//                        monthly recurring add-on AND as a one-month top-up; Commerce Starter and Commerce add-on only
//                        (Enterprise is unlimited); at most 3 blocks a month per company (recurring + top-ups together)
export const COMMERCE_PRICING = {
  starter: { usd: 49, pkr: 8000, basePlan: "professional", branches: 1, tills: 1, connectedStores: 1, monthlyOrders: 300 },
  addon: { usd: 79, pkr: 12000, basePlan: "business", branches: 2, tills: 3, connectedStores: 2, monthlyOrders: 1000 },
  bundle: { usd: 169, pkr: 40000, basePlan: "business" },
  enterprise: { included: true, branches: null, tills: null, connectedStores: 3, monthlyOrders: null },
  extraBranch: { usd: 19, pkr: 5000 },
  extraTill: { usd: 12, pkr: 3000 },
  orderBlock: { usd: 15, pkr: 2500, orders: 1000, maxBlocks: 3, plans: ["professional", "business"] },
  annualMonthsCharged: 10,
};

/** "YYYY-MM" of a date in UTC: the same calendar month the synced-order count uses. */
export const orderMonthKey = (now = new Date()) => new Date(now).toISOString().slice(0, 7);

/**
 * Extra order capacity a company has this month from order blocks.
 * org.commerceOrderBlocks = recurring blocks (0-3); org.commerceOrderTopups = { "YYYY-MM": blocks bought for that month only }.
 * Recurring + this month's top-ups never count for more than maxBlocks, and only on plans that can buy blocks.
 */
export function orderBlockAllowance(org, now = new Date()) {
  const ob = COMMERCE_PRICING.orderBlock;
  if (!ob.plans.includes(org?.plan)) return { eligible: false, recurring: 0, topup: 0, blocks: 0, extraOrders: 0, maxBlocks: ob.maxBlocks };
  const int = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const recurring = Math.min(ob.maxBlocks, int(org?.commerceOrderBlocks));
  const topup = Math.min(ob.maxBlocks - recurring, int(org?.commerceOrderTopups?.[orderMonthKey(now)]));
  const blocks = recurring + topup;
  return { eligible: true, recurring, topup, blocks, extraOrders: blocks * ob.orders, maxBlocks: ob.maxBlocks };
}

/** Validates an admin change; returns an error message or null. */
export function checkOrderBlockChange(org, { recurring = null, addTopup = null } = {}, now = new Date()) {
  const ob = COMMERCE_PRICING.orderBlock;
  if (!ob.plans.includes(org?.plan)) return org?.plan === "enterprise" ? "Enterprise already has unlimited online orders." : "Order blocks are for Commerce Starter (Professional) and the Commerce add-on (Business).";
  const cur = orderBlockAllowance(org, now);
  if (recurring !== null) {
    if (!Number.isInteger(recurring) || recurring < 0 || recurring > ob.maxBlocks) return `Monthly blocks must be a whole number from 0 to ${ob.maxBlocks}.`;
    if (recurring + cur.topup > ob.maxBlocks) return `That would make ${recurring + cur.topup} blocks this month with the top-ups already bought; the most is ${ob.maxBlocks}.`;
  }
  if (addTopup !== null) {
    if (!Number.isInteger(addTopup) || addTopup < 1) return "Add at least one top-up block.";
    if (cur.blocks + addTopup > ob.maxBlocks) return `This company already has ${cur.blocks} block(s) this month; the most is ${ob.maxBlocks}.`;
  }
  return null;
}
