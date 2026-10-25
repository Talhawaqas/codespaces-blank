// src/lib/pkPricing.js
//
// Pakistan pricing. Companies in Pakistan see their own PKR packages, paid
// by bank transfer and activated by Inaya once paid; everyone else sees the
// USD plans in src/lib/orgPlans.js, paid by card through Stripe. The two
// price lists are independent. Each PKR package is a plan tier (same id,
// user and storage limits as orgPlans.js), so enforcement is unchanged.
//
// Region comes from Vercel's x-vercel-ip-country header. A company that has
// asked for a PKR package keeps PKR pricing (org.billingRegion = "PK") even
// when its owner signs in from abroad.

export const PK_PACKAGES = {
  starter: { monthly: 8000, yearly: 80000, setupFee: 10000 },
  professional: { monthly: 20000, yearly: 200000, setupFee: 25000 },
  business: { monthly: 30000, yearly: 300000, setupFee: 25000 },
  enterprise: { monthly: 60000, yearly: 600000, setupFee: 25000 },
};
export const PK_EXTRA_USER_MONTHLY = 2500;
export const PK_PILOT = { months: 6, discountPercent: 30 };

/** "PK" for a company in Pakistan, otherwise "INTL". An org's saved region wins over the visitor's IP country. */
export function pricingRegion({ country, orgRegion } = {}) {
  if (orgRegion === "PK" || orgRegion === "INTL") return orgRegion;
  return String(country || "").toUpperCase() === "PK" ? "PK" : "INTL";
}

/** A pilot price: the standard price less the pilot discount, rounded to the nearest 100 rupees. */
export function pkPilotPrice(monthly) {
  return Math.round((monthly * (100 - PK_PILOT.discountPercent)) / 100 / 100) * 100;
}

/** `rupees` formatted for display: "PKR 20,000". */
export function formatPkr(rupees) {
  return `PKR ${Math.round(rupees).toLocaleString("en-US")}`;
}

/** A plan (as the plans API returns it) re-priced as a PKR package, paid by bank transfer. */
export function toPkPlan(plan) {
  const pk = PK_PACKAGES[plan.id];
  if (!pk) return null;
  return {
    ...plan,
    currency: "PKR",
    paymentMethod: "bank_transfer",
    contactSalesOnly: false,
    priceMonthly: pk.monthly,
    priceYearly: pk.yearly,
    setupFee: pk.setupFee,
    pilotMonthly: pkPilotPrice(pk.monthly),
    pilotMonths: PK_PILOT.months,
    pilotDiscountPercent: PK_PILOT.discountPercent,
    extraUserMonthly: PK_EXTRA_USER_MONTHLY,
  };
}
