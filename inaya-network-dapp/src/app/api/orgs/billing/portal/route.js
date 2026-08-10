// app/api/orgs/billing/portal/route.js
//
// POST /api/orgs/billing/portal   { orgId }
//
// Owner/admin only. Opens Stripe's own hosted Billing Portal for the org's
// Stripe Customer — payment-method updates, interval changes, and
// cancellation all happen there instead of custom-built UI here.

import Stripe from "stripe";
import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../../lib/orgs.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(req) {
  try {
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { db } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const subscription = await db.collection("org_subscriptions").findOne({ orgId: orgObjectId });
    if (!subscription?.stripeCustomerId) {
      return NextResponse.json({ error: "No billing account yet — pick a plan first." }, { status: 400 });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/business`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err) {
    console.error("orgs/billing/portal POST failed:", err);
    return NextResponse.json({ error: err.message || "Could not open billing portal." }, { status: 500 });
  }
}
