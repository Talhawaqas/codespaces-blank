// src/lib/dappPricing.js
//
// The Dapp (storage network) price book: one place for every Dapp price the
// web app shows or charges. Business Workspace pricing is separate
// (orgPlans.js / pkPricing.js) and is not affected by anything here.
//
// The two live contracts hold the authoritative on-chain values and the app
// reads them where it can (InayaCustody.usdtFeePerGB, the PAYG contract's
// storagePricePerTB / egressPricePerHalfTB / annualMaintenanceFee). The
// numbers below are what those contracts are set to, used for display
// defaults, card (Stripe) checkouts and anything that cannot read the chain.
// Changing a price means changing it here AND on-chain (owner-only setters).
//
// Price book of 13 Nov 2026 (previously 4.5 USDT/TB, 5 USDT/yr, 39% to nodes).

/** Pay-as-you-go storage, USDT per TB per month. */
export const STORAGE_USDT_PER_TB_MONTH = 6.49;

/** One-time upload fee per GB: one month of storage, so InayaCustody.usdtFeePerGB = 6.49 / 1024. */
export const UPLOAD_USDT_PER_GB = STORAGE_USDT_PER_TB_MONTH / 1024;

/** Flat account fee, USDT per year (the PAYG contract's annualMaintenanceFee). */
export const ACCOUNT_FEE_USDT_PER_YEAR = 12;

/** Retrieval beyond the included monthly allowance: INAYA per 0.5 TB. Charged from mainnet. */
export const EGRESS_INAYA_PER_HALF_TB = 10;

/**
 * Corporate Reserve: annual prepaid allocations with a volume discount off the
 * pay-as-you-go rate. `usdtPerYear` = tb * usdtPerTbMonth * 12.
 */
export const CORPORATE_RESERVE_TIERS = {
  "250 TB / Year": { tb: 250, usdtPerTbMonth: 5.99, usdtPerYear: 17970, maintenanceUsdtEq: 500 },
  "500 TB / Year": { tb: 500, usdtPerTbMonth: 5.79, usdtPerYear: 34740, maintenanceUsdtEq: 1000 },
  "1000 TB / Year": { tb: 1000, usdtPerTbMonth: 5.49, usdtPerYear: 65880, maintenanceUsdtEq: 2000 },
};

/** How each storage payment is split. Node operators' share is escrowed and released monthly. */
export const NODE_SHARE_PERCENT = 35;
export const TREASURY_SHARE_PERCENT = 55;
export const TEAM_SHARE_PERCENT = 10;

/**
 * Competitor list prices, USD, for the comparison tables. `verified` marks
 * figures read from the provider's own pricing page on 13 Nov 2026; the rest
 * are widely reported list prices we could not read from the provider's page
 * that day, so the UI labels the table as indicative.
 */
export const COMPETITOR_PRICES = [
  { name: "Amazon S3 (Standard)", storagePerTb: 23, egress: "~90 USDT", minimum: "None", verified: false },
  { name: "Google Cloud Storage", storagePerTb: 20, egress: "~120 USDT", minimum: "None", verified: false },
  { name: "Cloudflare R2", storagePerTb: 15, egress: "Free", minimum: "None", verified: true },
  { name: "Wasabi", storagePerTb: 7.99, egress: "Free within limits", minimum: "1 TB, 90 days", verified: false },
  { name: "Storj", storagePerTb: 7, egress: "7 USDT", minimum: "5 USDT / month", verified: true },
  { name: "Backblaze B2", storagePerTb: 6.95, egress: "Free to 3x stored, then 10 USDT", minimum: "None", verified: true },
];

/** A year of storage at competitor list prices, for the Corporate Reserve table (storage only, no egress). */
export function competitorAnnualCost(tb) {
  // S3 Standard tiers: first 50 TB at 23, next 450 TB at 22, beyond 500 TB at 21 (USD per TB per month).
  const s3Monthly = Math.min(tb, 50) * 23 + Math.min(Math.max(tb - 50, 0), 450) * 22 + Math.max(tb - 500, 0) * 21;
  return { s3: Math.round(s3Monthly * 12), b2: Math.round(tb * 6.95 * 12) };
}

export const formatUsdt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
