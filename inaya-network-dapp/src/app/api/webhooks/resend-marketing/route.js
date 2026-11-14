// POST /api/webhooks/resend-marketing -- Resend delivery events for MARKETING email (delivered, bounced, complained,
// delivery_delayed). Signed by Resend (Svix) with RESEND_MARKETING_WEBHOOK_SECRET (falls back to RESEND_WEBHOOK_SECRET).
// Bounces and complaints add the address to the org's suppression list automatically.
import { NextResponse } from "next/server";
import { verifySvix } from "../../../../lib/support/inboundResend.js";
import { handleProviderEvent } from "../../../../lib/engagement/sender.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req) {
  try {
    const secret = process.env.RESEND_MARKETING_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return NextResponse.json({ error: "Marketing webhooks are not configured." }, { status: 503 });
    const raw = await req.text();
    if (raw.length > 256 * 1024) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
    const ok = verifySvix({ id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature"), rawBody: raw, secret });
    if (!ok) return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    let event; try { event = JSON.parse(raw); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
    const r = await handleProviderEvent(event);
    return NextResponse.json(r);
  } catch (err) {
    console.error("resend marketing webhook failed:", err?.message);
    return NextResponse.json({ error: "Try again later." }, { status: 503 });
  }
}
