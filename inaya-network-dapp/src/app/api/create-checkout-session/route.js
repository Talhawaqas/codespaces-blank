// app/api/create-checkout-session/route.js
//
// Creates a Stripe Checkout session for a Corporate Reserve tier. The
// customer never sees a wallet — Stripe collects the card and email,
// and email is what the dashboard later uses to look up their plan
// (see /api/corporate-plan-status).

import Stripe from "stripe";
import { NextResponse } from "next/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Mirrors the existing tier pricing already live in page.js (selectedB2BTier).
const TIER_PRICES_USD = {
  "250 TB / Year": 13500,
  "500 TB / Year": 27000,
  "1000 TB / Year": 54000,
};

export async function POST(req) {
  try {
    const { tier } = await req.json();
    const amount = TIER_PRICES_USD[tier];

    if (!amount) {
      return NextResponse.json({ error: `Unknown tier "${tier}".` }, { status: 400 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Inaya Network Corporate Reserve — ${tier}`,
              description: "Annual enterprise storage allocation, settled on-chain via RevenueRouter.",
            },
            unit_amount: amount * 100, // Stripe expects cents
          },
          quantity: 1,
        },
      ],
      metadata: { tier }, // read back in the webhook to know which plan to activate
      // This is a single-page app (page.js switches tabs via client-side state,
      // not real routes) — so both redirects point at the root, with a query
      // param page.js reads on load to auto-switch to the right tab.
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=success&tier=${encodeURIComponent(tier)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=cancelled`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}