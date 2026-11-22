// POST /api/shop/channels/{shopify|woocommerce}/{channelId} -- order and product webhooks from a connected store. The HMAC is
// checked with that connection's secret; order webhooks only trigger a re-read of the order from the platform's API.
import { NextResponse } from "next/server";
import { channelWebhook } from "../../../../../../lib/online/channels.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req, { params }) {
  const { platform, channelId } = await params;
  const P = { shopify: "SHOPIFY", woocommerce: "WOOCOMMERCE" }[String(platform).toLowerCase()];
  if (!P) return NextResponse.json({ error: "Not found." }, { status: 404 });
  try {
    const raw = await req.text();
    const r = await channelWebhook({ platform: P, channelId, rawBody: raw, headers: req.headers });
    return r.error ? NextResponse.json({ error: r.error }, { status: r.status || 400 }) : NextResponse.json({ received: true });
  } catch (e) { console.error("channel webhook failed:", e.message); return NextResponse.json({ error: "Temporary failure." }, { status: 500 }); }
}
