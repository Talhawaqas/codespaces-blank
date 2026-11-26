// app/api/orgs/billing/plans/route.js
//
// GET /api/orgs/billing/plans
//
// Public, unauthenticated plan catalog — powers the marketing pricing page
// (src/app/business/pricing/page.js), which anonymous visitors need to be
// able to load before they've signed in or picked a company. The
// authenticated GET /api/orgs/billing route also returns this same shape
// under `availablePlans` for the in-app switcher; kept as two routes
// rather than one because that route requires orgId + a valid session,
// which an anonymous visitor doesn't have yet.

import { NextResponse } from "next/server";
import { PLANS, PLAN_ORDER } from "../../../../../lib/orgPlans.js";
import { pricingRegion, toPkPlan } from "../../../../../lib/pkPricing.js";
import { addOnCatalogue, ADD_ON_PLAN } from "../../../../../lib/addOns.js";
import { getOrgCollections, requireMembership, toObjectId } from "../../../../../lib/orgs.js";

// Plans for the visitor's region (src/lib/pkPricing.js): PKR packages paid by
// bank transfer for companies in Pakistan, USD plans with card checkout for
// everyone else. Only the one price list is sent, so a visitor from Pakistan
// never receives the USD prices. With ?orgId= from a signed-in member, that
// company's saved region wins over the visitor's country.
// ?region=pk|intl overrides for testing.
export const dynamic = "force-dynamic";

export async function GET(req) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId");
  let orgRegion = null;
  let pendingRequest = null;
  if (orgId) {
    try {
      const auth = await requireMembership(req, orgId);
      if (!auth.error) {
        const { orgs, db } = await getOrgCollections();
        orgRegion = (await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { billingRegion: 1 } }))?.billingRegion || null;
        // A package already requested and awaiting payment: the plan-selection screen shows it.
        const pending = await db.collection("billing_requests").findOne({ orgId: toObjectId(orgId), status: "pending" }, { projection: { planId: 1, requestedAt: 1 } });
        if (pending) pendingRequest = { planId: pending.planId, requestedAt: pending.requestedAt };
      }
    } catch { /* fall back to the visitor's country */ }
  }
  const override = { pk: "PK", intl: "INTL" }[url.searchParams.get("region")] || null;
  const region = override || pricingRegion({ country: req.headers.get("x-vercel-ip-country"), orgRegion });

  const base = PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    return {
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      color: p.color,
      popular: !!p.popular,
      contactSalesOnly: !!p.contactSalesOnly,
      priceMonthly: p.priceMonthly,
      priceYearly: p.priceYearly,
      maxUsers: p.maxUsers,
      maxStorageGB: p.maxStorageGB,
      maxFileSizeMB: p.maxFileSizeMB,
      features: p.features,
    };
  });
  const plans = region === "PK"
    ? base.map(toPkPlan).filter(Boolean)
    : base.map((p) => ({ ...p, currency: "USD", paymentMethod: "request" }));
  // Professional-only add-ons (src/lib/addOns.js), priced in the region's currency.
  const addOns = { plan: ADD_ON_PLAN, items: addOnCatalogue().map((a) => ({ id: a.id, name: a.name, perUnit: a.perUnit, max: a.max, priceMonthly: region === "PK" ? a.pkr : a.usd })) };
  return NextResponse.json({ region, currency: region === "PK" ? "PKR" : "USD", plans, addOns, pendingRequest }, { headers: { "Cache-Control": "private, no-store", Vary: "x-vercel-ip-country" } });
}
