// POST /api/shop/webhooks/safepay/{storeId} -- a shop's OWN Safepay account notifies us here. X-SFPY-SIGNATURE is checked with the
// endpoint's shared secret, then the payment is re-read from Safepay's reporter API before anything is recorded.
import { NextResponse } from "next/server";
import { safepayWebhook } from "../../../../../../lib/online/payments.js";

export const dynamic = "force-dynamic";
export async function POST(req, { params }) {
  const { storeId } = await params;
  try {
    const raw = await req.text();
    const r = await safepayWebhook({ storeId, rawBody: raw, signature: req.headers.get("x-sfpy-signature") });
    return r.error ? NextResponse.json({ error: r.error }, { status: r.status || 400 }) : NextResponse.json({ received: true });
  } catch (e) { console.error("safepay store webhook failed:", e.message); return NextResponse.json({ error: "Temporary failure." }, { status: 500 }); }
}
