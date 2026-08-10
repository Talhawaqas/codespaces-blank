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

export async function GET() {
  const plans = PLAN_ORDER.map((id) => {
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
  return NextResponse.json({ plans });
}
