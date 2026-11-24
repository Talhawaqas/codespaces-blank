// src/lib/whyInaya/pricing.server.js -- server only: current public prices for the Why Inaya page and the AI explainer,
// read from the canonical pricing code (orgPlans.js imports server modules, so this never goes to the browser directly;
// the page passes the plain numbers down as props).
import { PLANS } from "../orgPlans.js";
import { PK_PACKAGES } from "../pkPricing.js";
import { COMMERCE_PRICING } from "../commercePricing.js";

/** Current public prices, read from the canonical pricing code (never typed here). */
export function pricingFacts() {
  const CP = COMMERCE_PRICING;
  return {
    usd: {
      starter: PLANS.starter.priceMonthly, professional: PLANS.professional.priceMonthly, business: PLANS.business.priceMonthly, enterprise: PLANS.enterprise.priceMonthly,
      commerceStarter: CP.starter.usd, commerceAddon: CP.addon.usd, bundle: CP.bundle.usd, extraBranch: CP.extraBranch.usd, extraTill: CP.extraTill.usd, orderBlock: CP.orderBlock.usd,
    },
    pkr: {
      starter: PK_PACKAGES.starter.monthly, professional: PK_PACKAGES.professional.monthly, business: PK_PACKAGES.business.monthly, enterprise: PK_PACKAGES.enterprise.monthly,
      commerceStarter: CP.starter.pkr, commerceAddon: CP.addon.pkr, bundle: CP.bundle.pkr, extraBranch: CP.extraBranch.pkr, extraTill: CP.extraTill.pkr, orderBlock: CP.orderBlock.pkr,
    },
    users: { starter: PLANS.starter.maxUsers, professional: PLANS.professional.maxUsers, business: PLANS.business.maxUsers, enterprise: PLANS.enterprise.maxUsers },
    commerce: { starter: CP.starter, addon: CP.addon, enterprise: CP.enterprise, orderBlock: CP.orderBlock },
  };
}
