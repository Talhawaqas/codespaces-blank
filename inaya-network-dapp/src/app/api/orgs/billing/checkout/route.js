// app/api/orgs/billing/checkout/route.js
//
// POST /api/orgs/billing/checkout   { orgId, planId, interval: "month"|"year" }
// POST body may add extraUsers (0 up to the plan's maxExtraUsers, $3/user/month).
//   -> { url } for a new subscription, or { upgraded: true } when an existing one was changed in place
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
import { PLANS, planChangeError, EXTRA_USER_MONTHLY_USD } from "../../../../../lib/orgPlans.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const TRIAL_DAYS = 14; // matches "Start Free Trial" wording on the pricing cards

// Extra users are a second subscription item, recognised by its product's metadata.
const EXTRA_USERS_KIND = "extra_users";
const extraUsersProduct = () => ({ name: "Inaya Business Workspace — extra user", metadata: { kind: EXTRA_USERS_KIND } });
// A year costs 10 months, like the plans' yearly prices.
const extraUsersPrice = (product, interval) => ({
  currency: "usd",
  product,
  unit_amount: Math.round(EXTRA_USER_MONTHLY_USD * (interval === "year" ? 10 : 1) * 100),
  recurring: { interval },
});

export async function POST(req) {
  try {
    let reqBody = {}; try { reqBody = await req.json(); } catch { reqBody = {}; }
    const { orgId, planId, interval = "month" } = reqBody;
    const extraUsers = Number(reqBody.extraUsers) || 0;

    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const plan = PLANS[planId];
    if (!plan) return NextResponse.json({ error: `Unknown plan "${planId}".` }, { status: 400 });
    if (plan.contactSalesOnly) {
      return NextResponse.json({ error: "Enterprise is contact-sales only — reach out to get set up." }, { status: 400 });
    }
    if (interval !== "month" && interval !== "year") {
      return NextResponse.json({ error: "interval must be 'month' or 'year'." }, { status: 400 });
    }
    const invalid = planChangeError({ planId, extraUsers });
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs, db } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const org = await orgs.findOne({ _id: orgObjectId });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const subscriptions = db.collection("org_subscriptions");
    const existing = await subscriptions.findOne({ orgId: orgObjectId });

    // One subscription per company. A second Checkout would start a second
    // Stripe subscription and bill twice, so a company that already pays by
    // card changes its existing subscription in place instead: a larger
    // package and/or more extra users (Stripe prorates the difference).
    const live = existing?.stripeSubscriptionId && ["active", "trialing", "past_due"].includes(existing.status);
    if (live) {
      const blocked = planChangeError({ currentPlanId: org.plan, currentExtraUsers: org.extraUsers || 0, active: true, planId, extraUsers });
      if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
      const current = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId, { expand: ["items.data.price.product"] });
      const isExtraItem = (it) => it.price.product?.metadata?.kind === EXTRA_USERS_KIND;
      const planItem = current.items.data.find((it) => !isExtraItem(it));
      const extraItem = current.items.data.find(isExtraItem);
      const keepInterval = planItem.price.recurring?.interval || "month";
      const items = [{
        id: planItem.id,
        price_data: {
          currency: "usd",
          product: planItem.price.product.id,
          unit_amount: Math.round((keepInterval === "year" ? plan.priceYearly : plan.priceMonthly) * 100),
          recurring: { interval: keepInterval },
        },
      }];
      if (extraUsers > 0) {
        const product = extraItem?.price.product.id || (await stripe.products.create(extraUsersProduct())).id;
        items.push({ ...(extraItem ? { id: extraItem.id } : {}), price_data: extraUsersPrice(product, keepInterval), quantity: extraUsers });
      } else if (extraItem) {
        items.push({ id: extraItem.id, deleted: true });
      }
      await stripe.subscriptions.update(current.id, {
        items,
        proration_behavior: "create_prorations",
        metadata: { ...current.metadata, orgId: orgId.toString(), planId, extraUsers: String(extraUsers) },
      });
      const now = new Date().toISOString();
      await subscriptions.updateOne({ orgId: orgObjectId }, { $set: { plan: planId, updatedAt: now } });
      await orgs.updateOne({ _id: orgObjectId }, { $set: { plan: planId, extraUsers, planUpdatedAt: now } });
      return NextResponse.json({ upgraded: true, planId, extraUsers });
    }

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
        ...(extraUsers > 0
          ? [{ price_data: { currency: "usd", product_data: extraUsersProduct(), unit_amount: extraUsersPrice(null, interval).unit_amount, recurring: { interval } }, quantity: extraUsers }]
          : []),
      ],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: { orgId: orgId.toString(), planId, extraUsers: String(extraUsers) },
      },
      // Read back by the webhook to know this is an org subscription (vs.
      // Corporate Reserve/PAYG/egress) and which org/plan/interval it belongs to.
      metadata: { orgId: orgId.toString(), planId, interval, extraUsers: String(extraUsers), checkoutType: "org_subscription" },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/business?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/business?billing=cancelled`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("orgs/billing/checkout POST failed:", err);
    return NextResponse.json({ error: err.message || "Could not start checkout." }, { status: 500 });
  }
}
