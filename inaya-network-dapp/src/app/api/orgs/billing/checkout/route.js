// app/api/orgs/billing/checkout/route.js
//
// POST /api/orgs/billing/checkout   { orgId, planId, interval: "month"|"year" }
//
// Owner/admin only (same requireManage gate as inviting members). Starts a
// real Stripe Checkout subscription for one of the 3 self-serve tiers —
// Enterprise is contact-sales only, never goes through this route.
//
// Mirrors create-checkout-session/route.js's price_data-inline pattern
// (no Stripe Dashboard Products/Prices to keep in sync) but in
// mode: "subscription" instead of "payment", since a plan is recurring.
// Reuses the same STRIPE_SECRET_KEY the Corporate Reserve flow already
// uses — whatever mode that key is in (test/live) is what this uses too.
//
// Unlike the anonymous card-customer flow (settleCorporateReserve, keyed
// by email), the org member already has a real session — success/cancel
// both redirect back into the authenticated Business Workspace, and the
// existing session cookie carries across the Stripe redirect normally.

import Stripe from "stripe";
import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../../lib/orgs.js";
import { PLANS } from "../../../../../lib/orgPlans.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const TRIAL_DAYS = 14; // matches "Start Free Trial" wording on the pricing cards

export async function POST(req) {
  try {
    const { orgId, planId, interval = "month" } = await req.json();

    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const plan = PLANS[planId];
    if (!plan) return NextResponse.json({ error: `Unknown plan "${planId}".` }, { status: 400 });
    if (plan.contactSalesOnly) {
      return NextResponse.json({ error: "Enterprise is contact-sales only — reach out to get set up." }, { status: 400 });
    }
    if (interval !== "month" && interval !== "year") {
      return NextResponse.json({ error: "interval must be 'month' or 'year'." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs, db } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const org = await orgs.findOne({ _id: orgObjectId });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const subscriptions = db.collection("org_subscriptions");
    const existing = await subscriptions.findOne({ orgId: orgObjectId });

    // Reuse the org's existing Stripe Customer across plan changes/renewals
    // rather than creating a new one every checkout.
    let customerId = existing?.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: auth.session.email,
        name: org.name,
        metadata: { orgId: orgId.toString() },
      });
      customerId = customer.id;
      await subscriptions.updateOne(
        { orgId: orgObjectId },
        { $set: { orgId: orgObjectId, stripeCustomerId: customerId, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    }

    const amount = interval === "year" ? plan.priceYearly : plan.priceMonthly;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Inaya Business Workspace — ${plan.name}`,
              description: plan.tagline,
            },
            unit_amount: Math.round(amount * 100),
            recurring: { interval },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: { orgId: orgId.toString(), planId },
      },
      // Read back by the webhook to know this is an org subscription (vs.
      // Corporate Reserve/PAYG/egress) and which org/plan/interval it belongs to.
      metadata: { orgId: orgId.toString(), planId, interval, checkoutType: "org_subscription" },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/business?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/business?billing=cancelled`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("orgs/billing/checkout POST failed:", err);
    return NextResponse.json({ error: err.message || "Could not start checkout." }, { status: 500 });
  }
}
