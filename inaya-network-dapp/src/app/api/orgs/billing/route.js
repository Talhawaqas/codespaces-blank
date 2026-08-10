// app/api/orgs/billing/route.js
//
// GET /api/orgs/billing?orgId=...
//   Any active member can view their org's current plan, usage against
//   that plan's limits, and subscription status — read-only, so this
//   doesn't need requireManage. Changing the plan (checkout/portal) does.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canManageOrg, toObjectId } from "../../../../lib/orgs.js";
import { getOrgPlan, getOrgUsage, PLANS, PLAN_ORDER } from "../../../../lib/orgPlans.js";

const BYTES_PER_GB = 1073741824;

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs, db } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const org = await orgs.findOne({ _id: orgObjectId });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const plan = getOrgPlan(org);
    const [usage, subscription] = await Promise.all([
      getOrgUsage(orgId),
      db.collection("org_subscriptions").findOne({ orgId: orgObjectId }),
    ]);

    return NextResponse.json({
      plan: {
        id: plan.id,
        name: plan.name,
        maxUsers: plan.maxUsers === Infinity ? null : plan.maxUsers,
        maxStorageGB: plan.maxStorageGB === Infinity ? null : plan.maxStorageGB,
        maxFileSizeMB: plan.maxFileSizeMB === Infinity ? null : plan.maxFileSizeMB,
      },
      usage: {
        users: { used: usage.activeUsers, max: plan.maxUsers === Infinity ? null : plan.maxUsers },
        storageGB: {
          used: Number((usage.storageUsedBytes / BYTES_PER_GB).toFixed(3)),
          max: plan.maxStorageGB === Infinity ? null : plan.maxStorageGB,
        },
      },
      subscription: subscription
        ? {
            status: subscription.status,
            billingInterval: subscription.billingInterval,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
      canManage: canManageOrg(auth.membership),
      availablePlans: PLAN_ORDER.map((id) => {
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
      }),
    });
  } catch (err) {
    console.error("orgs/billing GET failed:", err);
    return NextResponse.json({ error: "Could not fetch billing info." }, { status: 500 });
  }
}
