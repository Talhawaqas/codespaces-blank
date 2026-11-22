// POST /api/shop/shopify/compliance -- Shopify's mandatory privacy webhooks for Inaya's app (customers/data_request,
// customers/redact, shop/redact) plus app/uninstalled. HMAC-verified with the app secret (src/lib/online/shopifyApp.js).
import { NextResponse } from "next/server";
import { shopifyAppWebhook } from "../../../../../lib/online/shopifyApp.js";

export const dynamic = "force-dynamic";
export async function POST(req) {
  try {
    const raw = await req.text();
    const r = await shopifyAppWebhook({ topic: req.headers.get("x-shopify-topic"), shopDomain: req.headers.get("x-shopify-shop-domain"), rawBody: raw, hmac: req.headers.get("x-shopify-hmac-sha256") });
    return r.error ? NextResponse.json({ error: r.error }, { status: r.status || 400 }) : NextResponse.json({ received: true });
  } catch (e) { console.error("shopify compliance webhook failed:", e.message); return NextResponse.json({ error: "Temporary failure." }, { status: 500 }); }
}
