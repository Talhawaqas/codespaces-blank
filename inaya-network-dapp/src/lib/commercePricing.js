// src/lib/commercePricing.js -- Inaya Commerce prices (owner APPROVED 23 Nov 2026). One source for the pricing page,
// the plan limits and the documents. Monthly prices; annual = 10x monthly (two months free), as for the base plans.
//   Commerce Starter  -- add-on to Professional: 1 branch, 1 till, own web store, ONE connected store (Shopify OR WooCommerce), 300 online orders a month
//   Commerce add-on   -- add-on to Business: 2 branches, 3 tills, own web store, 1 Shopify + 1 WooCommerce, 1,000 online orders a month
//   Business + Commerce bundle -- the Business plan with the Commerce add-on at a saving
//   Enterprise        -- Commerce INCLUDED: unlimited branches and tills, 3 connected stores, unlimited orders
//   Extras            -- extra branch / extra till, monthly
export const COMMERCE_PRICING = {
  starter: { usd: 49, pkr: 8000, basePlan: "professional", branches: 1, tills: 1, connectedStores: 1, monthlyOrders: 300 },
  addon: { usd: 79, pkr: 12000, basePlan: "business", branches: 2, tills: 3, connectedStores: 2, monthlyOrders: 1000 },
  bundle: { usd: 169, pkr: 40000, basePlan: "business" },
  enterprise: { included: true, branches: null, tills: null, connectedStores: 3, monthlyOrders: null },
  extraBranch: { usd: 19, pkr: 5000 },
  extraTill: { usd: 12, pkr: 3000 },
  annualMonthsCharged: 10,
};
