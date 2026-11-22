// POST /api/shop/webhooks/stripe/{storeId} -- a shop's OWN Stripe account notifies us here (the shop adds this URL in its Stripe
// dashboard). The signature is checked with that shop's signing secret, then the payment is re-read from Stripe before anything
// is recorded (src/lib/online/payments.js).
import { NextResponse } from "next/server";
import { stripeWebhook } from "../../../../../../lib/online/payments.js";

export const dynamic = "force-dynamic";
export async function POST(req, { params }) {
  const { storeId } = await params;
  try {
    const raw = await req.text();
    const r = await stripeWebhook({ storeId, rawBody: raw, signature: req.headers.get("stripe-signature") });
    return r.error ? NextResponse.json({ error: r.error }, { status: r.status || 400 }) : NextResponse.json({ received: true });
  } catch (e) { console.error("stripe store webhook failed:", e.message); return NextResponse.json({ error: "Temporary failure." }, { status: 500 }); } // 5xx -> Stripe retries
}
