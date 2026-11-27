// src/lib/addOns.js
//
// Add-ons for the Professional package (founder + co-founder decision, 26 Nov 2026). Selected Business features can be bought
// one at a time on top of Professional. Business-defining features (admin dashboard, policies, audit logs, device management,
// advanced AI, Manage Orders) and Enterprise features (SSO, retention, compliance) are never add-ons.
//
// Prices: USD monthly (a year is 10 months, like the packages) and PKR (lean set). Storage is priced above Business's effective
// per-TB rate on purpose (Filebase costs ~$15/TB): a small top-up pays well, and heavy users are better off on Business.
// Add-ons are not discounted in the PKR pilot.
//
// Business add-on (owner decision 27 Nov 2026): Microsoft Power BI ($79 / PKR 10,000), which is otherwise Enterprise only.
// Each add-on names the package(s) it is sold on (`plans`); it only counts while the company is on one of them.
//
// Stored on the company as `org.addOns` = { appointments, campaigns, connect, clientPortal, customDomain, apiAccess: bool,
// storageTB: 0-4 }, set when Inaya activates a paid request (billingRequests.js), exactly like extra users. They only count while
// the company is on Professional: a larger package already includes them, and a smaller one cannot use them.

import { PLANS } from "./orgPlans.js";
import { PK_PACKAGES } from "./pkPricing.js";

export const ADD_ON_PLAN = "professional";
export const MAX_STORAGE_TB = 4; // Professional 1 TB + 4 = 5 TB, Business's allowance; past that, Business is the answer

export const ADD_ONS = {
  appointments: { name: "Appointment booking & team calendars", usd: 15, pkr: 3000 },
  campaigns: { name: "Email campaigns (10,000 emails/month)", usd: 15, pkr: 3000, monthlyEmails: 10000 },
  connect: { name: "Inaya Connect (WhatsApp Business & AI)", usd: 35, pkr: 6000 },
  clientPortal: { name: "Secure client portal", usd: 15, pkr: 3000, planFeature: "clientPortal" },
  customDomain: { name: "Custom domain", usd: 10, pkr: 2000, planFeature: "customDomain" },
  apiAccess: { name: "API access", usd: 15, pkr: 3000, planFeature: "apiAccess" },
  storageTB: { name: "Extra storage (per TB)", usd: 30, pkr: 7500, perUnit: true, max: MAX_STORAGE_TB },
  powerBi: { name: "Microsoft Power BI integration", usd: 79, pkr: 10000, planFeature: "powerBi", plans: ["business"] },
};
for (const a of Object.values(ADD_ONS)) a.plans ||= [ADD_ON_PLAN];
/** Pure: is this add-on sold on this package? */
export const addOnForPlan = (key, planId) => !!ADD_ONS[key]?.plans.includes(planId);
/** Packages that sell at least one add-on. */
export const ADD_ON_PLANS = [...new Set(Object.values(ADD_ONS).flatMap((a) => a.plans))];
export const ADD_ON_KEYS = Object.keys(ADD_ONS);
/** planGates.js feature key -> the add-on that unlocks it on Professional. */
export const FEATURE_ADD_ON = Object.fromEntries(Object.entries(ADD_ONS).filter(([, a]) => a.planFeature).map(([k, a]) => [a.planFeature, k]));

/** Pure: a clean add-on selection, or { error }. Each add-on is only sold on its own package(s); none selected is always fine. */
export function cleanAddOns(input, planId) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const k of ADD_ON_KEYS) {
    if (k === "storageTB") { const n = Number(src.storageTB || 0); if (!Number.isInteger(n) || n < 0 || n > MAX_STORAGE_TB) return { error: `Extra storage must be 0 to ${MAX_STORAGE_TB} TB. For more, choose Business.` }; if (n) out.storageTB = n; }
    else if (src[k] === true) out[k] = true;
  }
  const PLAN_RANK = ["starter", "professional", "business", "enterprise"];
  for (const k of Object.keys(out)) {
    if (addOnForPlan(k, planId)) continue;
    const sold = ADD_ONS[k].plans; const top = sold[sold.length - 1];
    const includes = PLAN_RANK.indexOf(planId) > PLAN_RANK.indexOf(top);
    const soldOn = sold.map((id) => PLANS[id]?.name || id).join(" or ");
    return { error: `${ADD_ONS[k].name} is an add-on for the ${soldOn} package. ${PLANS[planId]?.name || "This package"} ${includes ? "already includes it" : `cannot add it; choose ${soldOn}`}.` };
  }
  return { addOns: out };
}

const units = (addOns, k) => (k === "storageTB" ? Number(addOns?.storageTB || 0) : addOns?.[k] === true ? 1 : 0);

/** Pure: the add-ons' price for one billing period, in USD or PKR. */
export function addOnsPrice(addOns, { currency = "USD", interval = "month" } = {}) {
  const monthly = ADD_ON_KEYS.reduce((sum, k) => sum + units(addOns, k) * (currency === "PKR" ? ADD_ONS[k].pkr : ADD_ONS[k].usd), 0);
  return interval === "year" ? monthly * 10 : monthly;
}

/** Pure: "Inaya Connect, 2 TB extra storage" (or "" when none). */
export function describeAddOns(addOns) {
  return ADD_ON_KEYS.filter((k) => units(addOns, k)).map((k) => (k === "storageTB" ? `${addOns.storageTB} TB extra storage` : ADD_ONS[k].name)).join(", ");
}

/** Pure: when Professional + these add-ons (Professional's own; others are ignored) comes within `marginPct` of Business (or above it), the upgrade message, else null. */
export function upgradeHint(addOns, { currency = "USD" } = {}) {
  const pro = currency === "PKR" ? PK_PACKAGES.professional.monthly : PLANS.professional.priceMonthly;
  const biz = currency === "PKR" ? PK_PACKAGES.business.monthly : PLANS.business.priceMonthly;
  const own = Object.fromEntries(Object.entries(addOns || {}).filter(([k]) => addOnForPlan(k, ADD_ON_PLAN)));
  const total = pro + addOnsPrice(own, { currency });
  if (total < biz * 0.85) return null;
  const fmt = (n) => (currency === "PKR" ? `PKR ${n.toLocaleString("en-US")}` : `$${n}`);
  return total >= biz
    ? `Professional with these add-ons is ${fmt(total)} a month. Business is ${fmt(biz)} and includes all of them, plus 5 TB, 10 users and the admin features.`
    : `Professional with these add-ons is ${fmt(total)} a month. For ${fmt(biz - total)} more, Business includes all of them, plus 5 TB, 10 users and the admin features.`;
}

/** Pure: does this company have the add-on in force? Only while it is on a package that sells it. */
export function hasAddOn(org, key) { return addOnForPlan(key, org?.plan) && units(org?.addOns, key) > 0; }
/** Pure: extra storage in GB the company's add-ons give it. */
export function addOnStorageGB(org) { return org?.plan === ADD_ON_PLAN ? Math.min(Number(org?.addOns?.storageTB || 0), MAX_STORAGE_TB) * 1000 : 0; }

/** The catalogue for the pricing page and the request form. */
export function addOnCatalogue() {
  return ADD_ON_KEYS.map((k) => ({ id: k, name: ADD_ONS[k].name, usd: ADD_ONS[k].usd, pkr: ADD_ONS[k].pkr, perUnit: !!ADD_ONS[k].perUnit, max: ADD_ONS[k].max || 1, plans: ADD_ONS[k].plans }));
}
