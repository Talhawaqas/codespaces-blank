// app/api/resolve-checkout-session/route.js
//
// GET /api/resolve-checkout-session?session_id=cs_test_...
//
// Called once, right after the browser lands back from Stripe Checkout.
// Stripe already knows the customer's email (it collected it on the
// card form) — this fetches it server-side via the session_id Stripe
// appended to the redirect URL, and sets an http-only cookie so this
// browser is "recognized" on future visits without connecting a wallet
// or re-entering anything.

import Stripe from "stripe";
import { NextResponse } from "next/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year, matches the Corporate Reserve term

export async function GET(req) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "session_id query param is required" }, { status: 400 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // SQA-008 (S1): the cookie set below identifies this browser as `email` for a year and unlocks that customer's file list. A session
    // that was opened but never paid still carries whatever email was typed into the form, so anyone could obtain a cookie for a victim's
    // email without paying. Only a completed, PAID session may identify anyone.
    if (session.status !== "complete" || session.payment_status !== "paid") {
      return NextResponse.json({ error: "This checkout session has not been paid." }, { status: 402 });
    }
    const email = session.customer_details?.email;

    if (!email) {
      return NextResponse.json({ error: "No email on this checkout session" }, { status: 404 });
    }

    const response = NextResponse.json({ email });
    response.cookies.set("inaya_customer_email", email.toLowerCase(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });
    return response;
  } catch (err) {
    console.error("resolve-checkout-session error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}