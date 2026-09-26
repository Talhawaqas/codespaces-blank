// POST /api/support/inbound-email/resend -- Resend inbound webhook (`email.received`). See lib/support/inboundResend.js.
// Only a request signed by Resend (Svix signature with RESEND_WEBHOOK_SECRET) is accepted.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { verifySvix, handleReceived } from "../../../../../lib/support/inboundResend.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return NextResponse.json({ error: "Inbound email is not configured." }, { status: 503 });
    const raw = await req.text();
    if (raw.length > 512 * 1024) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
    const ok = verifySvix({ id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature"), rawBody: raw, secret });
    if (!ok) return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    let event; try { event = JSON.parse(raw); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
    if (event?.type !== "email.received") return NextResponse.json({ status: "IGNORED", reason: "EVENT_TYPE" });
    await ensureOrgIndexes();
    try { await checkRateLimit({ action: "support:inbound:resend", key: "all", max: 3000, windowMs: 3600000 }); } catch { return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 }); }
    const r = await handleReceived({ event });
    // a temporary failure returns 5xx so Resend retries; everything else is final
    if (r.status === "FAILED" && /Resend answered 5|timed out|fetch failed/i.test(String(r.reason))) return NextResponse.json({ error: "Try again later." }, { status: 503 });
    return NextResponse.json({ status: r.status, ticketId: r.ticketId || null, action: r.action || null, reason: r.reason || null, duplicate: !!r.duplicate });
  } catch (err) {
    console.error("resend inbound failed:", err?.message);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
