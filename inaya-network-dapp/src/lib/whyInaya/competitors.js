// src/lib/whyInaya/competitors.js -- competitor research register (SOW 3.5 / 7). Official pricing pages only, checked
// 24 Nov 2026. Never "Inaya wins": each record states what the product is strong at. Where the reviewed official page is
// silent, the status is NOT_ESTABLISHED ("not established from the reviewed official sources"), never "missing".
// The AI explainer may quote these records but must never extrapolate or invent a competitor price.

export const CHECKED = "24 November 2026";
export const STATUS = {
  INCLUDED: "Included",
  CONDITIONS: "Included with conditions",
  ADDON: "Paid add-on",
  SEPARATE: "Separate product / subscription",
  THIRD_PARTY: "Third-party integration",
  NOT_ESTABLISHED: "Not established from reviewed official sources",
};
export const DIMENSIONS = [
  { id: "ops", label: "Business operations (finance, HR, CRM, documents)" },
  { id: "pos", label: "Point of sale (returns, shifts, cash)" },
  { id: "inventory", label: "Inventory (multi-location, purchasing)" },
  { id: "online", label: "Online selling (own store, Shopify, WooCommerce)" },
  { id: "ai", label: "Built-in AI" },
  { id: "recovery", label: "Ransomware recovery (snapshots, rollback)" },
  { id: "offline", label: "Offline selling" },
  { id: "pricingBasis", label: "Pricing basis" },
];

// Inaya's own column is built from the capability register (content.js), not typed here.
export const INAYA_COLUMN = {
  ops: ["INCLUDED", "Finance, HR, CRM, documents in every package"],
  pos: ["CONDITIONS", "With Inaya Commerce"],
  inventory: ["INCLUDED", "Multi-branch stock, transfers, purchasing"],
  online: ["CONDITIONS", "Own web store + Shopify / WooCommerce sync with Inaya Commerce; synced orders by plan"],
  ai: ["CONDITIONS", "Permission-aware assistants; changes need approval"],
  recovery: ["INCLUDED", "Immutable snapshots and tested rollback"],
  offline: ["CONDITIONS", "Beta: cash sales, manager-enabled, with limits"],
  pricingBasis: ["INCLUDED", "Flat price per company per month (users included by package)"],
};

export const COMPETITORS = [
  {
    id: "odoo", name: "Odoo", product: "Odoo Standard", category: "ERP / business suite",
    strongAt: "A very broad app catalogue (accounting, CRM, HR, POS, eCommerce, manufacturing and more) under one subscription, with a large partner network for implementation.",
    price: "US$11.20 per user / month billed monthly, or US$8.95 billed yearly (first-year discount shown on the page)",
    limits: "Unlimited users at the per-user price; Odoo Online storage stated as up to 100 GB; implementation services and Odoo.sh hosting not included",
    dims: {
      ops: ["INCLUDED", "All apps on Standard: Accounting, CRM, HR, Sign and more"],
      pos: ["INCLUDED", "POS app included"],
      inventory: ["INCLUDED", "Inventory app included"],
      online: ["CONDITIONS", "Own eCommerce/Website app included; Shopify and WooCommerce not stated on the pricing page"],
      ai: ["CONDITIONS", "\"Agentic AI\" listed on the Custom plan; AI bill scanning uses paid credits"],
      recovery: ["NOT_ESTABLISHED", ""],
      offline: ["NOT_ESTABLISHED", ""],
      pricingBasis: ["INCLUDED", "Per user per month"],
    },
    sources: [{ label: "Odoo pricing", url: "https://www.odoo.com/pricing" }],
  },
  {
    id: "shopify", name: "Shopify", product: "Shopify Grow + POS Pro", category: "E-commerce platform with POS",
    strongAt: "Best-known online store platform with a huge app store, checkout and payments, and POS that works across many locations.",
    price: "Grow US$65 / month billed monthly (US$49 billed yearly); POS Pro +US$89 per location / month, billed yearly",
    limits: "Grow: 5 staff accounts, 10 inventory locations; 50 synced marketplace orders a month free, then 1% up to $99",
    dims: {
      ops: ["THIRD_PARTY", "Accounting and HR are not on the pricing pages; available through apps"],
      pos: ["CONDITIONS", "POS included; returns at any location, staff roles and inventory tools need POS Pro"],
      inventory: ["CONDITIONS", "Up to 10 locations on Grow; more inventory tools with POS Pro"],
      online: ["INCLUDED", "Shopify store; WooCommerce not applicable"],
      ai: ["NOT_ESTABLISHED", ""],
      recovery: ["NOT_ESTABLISHED", ""],
      offline: ["NOT_ESTABLISHED", ""],
      pricingBasis: ["INCLUDED", "Per store per month, plus POS Pro per location"],
    },
    note: "Inaya Commerce connects to Shopify rather than replacing it: a shop can keep its Shopify store and run the till and back office in Inaya.",
    sources: [{ label: "Shopify pricing", url: "https://www.shopify.com/pricing" }, { label: "Shopify POS pricing", url: "https://www.shopify.com/pos/pricing" }],
  },
  {
    id: "lightspeed", name: "Lightspeed", product: "Lightspeed Retail Basic", category: "Retail POS",
    strongAt: "Mature retail and restaurant point of sale with deep retail reporting, integrated payments and hardware.",
    price: "US$109 / month billed monthly, or US$89 billed yearly (with Lightspeed Payments); Core US$179 / $149, Plus US$339 / $289",
    limits: "1 register included; extra locations and registers priced separately",
    dims: {
      ops: ["NOT_ESTABLISHED", "Accounting and HR not stated as included on the retail pricing page"],
      pos: ["INCLUDED", "Retail POS"],
      inventory: ["INCLUDED", "Inventory management"],
      online: ["NOT_ESTABLISHED", "eCommerce is listed as a product; inclusion in Basic not established"],
      ai: ["NOT_ESTABLISHED", ""],
      recovery: ["NOT_ESTABLISHED", ""],
      offline: ["NOT_ESTABLISHED", ""],
      pricingBasis: ["INCLUDED", "Per location per month; extra registers extra"],
    },
    sources: [{ label: "Lightspeed Retail pricing", url: "https://www.lightspeedhq.com/pos/retail/pricing/" }],
  },
  {
    id: "zoho", name: "Zoho", product: "Zoho POS Standard + Zoho Inventory Standard", category: "POS and inventory apps",
    strongAt: "Low entry prices and a wide family of separate business apps (Books, CRM, Inventory, POS) that integrate with each other.",
    price: "Zoho POS Standard US$20 per location / month billed monthly ($15 billed annually); Zoho Inventory Standard US$29 per organisation / month billed annually",
    limits: "POS Standard: 1 register, 3 users. Inventory Standard: 500 orders a month, 2 users, 2 locations",
    dims: {
      ops: ["SEPARATE", "Accounting (Zoho Books), CRM and HR are separate Zoho products"],
      pos: ["SEPARATE", "Zoho POS is its own subscription"],
      inventory: ["SEPARATE", "Zoho Inventory, with order, user and location caps"],
      online: ["CONDITIONS", "Zoho Inventory lists Shopify and WooCommerce integrations; Zoho Commerce is separate"],
      ai: ["NOT_ESTABLISHED", ""],
      recovery: ["NOT_ESTABLISHED", ""],
      offline: ["NOT_ESTABLISHED", ""],
      pricingBasis: ["INCLUDED", "Per app; POS per location, Inventory per organisation"],
    },
    sources: [{ label: "Zoho POS pricing", url: "https://www.zoho.com/pos/pricing.html" }, { label: "Zoho Inventory pricing", url: "https://www.zoho.com/inventory/pricing/" }],
  },
  {
    id: "cin7", name: "Cin7", product: "Cin7 Standard", category: "Inventory and order management",
    strongAt: "Inventory and order management for growing product businesses, with many channel integrations, unlimited inventory locations and warehouse tools on higher plans.",
    price: "US$349 / month (Pro US$599, Advanced US$1,199)",
    limits: "5 users, 2 e-commerce/app integrations, 6,000 sale orders a year, unlimited inventory locations",
    dims: {
      ops: ["THIRD_PARTY", "Accounting through Xero or QuickBooks Online"],
      pos: ["NOT_ESTABLISHED", "Point-of-sale systems connect through integrations"],
      inventory: ["INCLUDED", "Core product; unlimited locations"],
      online: ["CONDITIONS", "E-commerce through integrations (2 on Standard, more for purchase)"],
      ai: ["CONDITIONS", "AI product descriptions"],
      recovery: ["NOT_ESTABLISHED", ""],
      offline: ["NOT_ESTABLISHED", ""],
      pricingBasis: ["INCLUDED", "Per month by plan; users and order volume capped"],
    },
    sources: [{ label: "Cin7 pricing", url: "https://www.cin7.com/pricing/" }],
  },
];

// One stated configuration for the price comparison (SOW 3.5 fair comparison rules).
export const PRICE_SCENARIO = {
  title: "One shop: 1 branch, 1 till, 5 staff, an online store, billed monthly, USD",
  rows: [
    { who: "Inaya Business OS", config: "Professional + Commerce Starter (finance, HR, CRM, documents, till, own web store or 1 Shopify / WooCommerce store, 300 synced orders a month)", priceKey: "inaya" },
    { who: "Odoo", config: "Standard, 5 users x US$11.20 (all apps); first-year discount lowers this; implementation not included", monthly: 56 },
    { who: "Shopify", config: "Grow (5 staff accounts) US$65 + POS Pro US$89 (billed yearly); accounting and HR through apps, not included", monthly: 154 },
    { who: "Lightspeed", config: "Retail Basic US$109 (1 register, with Lightspeed Payments); accounting and HR not included", monthly: 109 },
    { who: "Zoho", config: "POS Standard US$20 + Inventory Standard US$29 (billed annually); accounting (Books) not included", monthly: 49 },
  ],
  caveat: "Each product does different things well, so the same monthly figure buys different things. Figures are list prices from the official pages on the date checked, before tax, payment-processing fees and implementation.",
};
