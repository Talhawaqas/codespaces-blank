// app/api/connect/whatsapp/route.js -- Inaya Connect: the one public WhatsApp Cloud API webhook (SOW B2, 8.1, 8.2).
//   GET  Meta's verification handshake (hub.mode/hub.verify_token/hub.challenge), matched to ONE pending connection.
//   POST events: tenant from metadata.phone_number_id only, HMAC X-Hub-Signature-256 checked with that connection's app
//        secret, messages stored once (deduplicated by WhatsApp message id). Replies are produced AFTER the 200 response
//        (Meta retries slow webhooks), with the cron as the safety net for anything left pending.
// No session or cookies: authenticity comes from the signature. Rate limited per IP as a flood guard.
import { NextResponse, after } from "next/server";
import { verifyChallenge, receiveEvents } from "../../../../lib/connect/webhook.js";
import { processPending } from "../../../../lib/connect/process.js";
import { ensureConnectIndexes } from "../../../../lib/connect/core.js";
import { slidingWindowCheck } from "../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const ip = (req) => String(req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
async function flooded(req) { try { const r = await slidingWindowCheck({ action: "connect-webhook", key: ip(req), max: 600, windowMs: 60000 }); return r?.allowed === false || r?.limited === true; } catch { return false; } }

export async function GET(req) {
  if (await flooded(req)) return new NextResponse("Too many requests", { status: 429 });
  try { const r = await verifyChallenge(Object.fromEntries(new URL(req.url).searchParams)); return new NextResponse(r.text, { status: r.status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } }); }
  catch (e) { console.error("connect webhook verify:", e?.message); return new NextResponse("Error", { status: 500 }); }
}

export async function POST(req) {
  if (await flooded(req)) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  try {
    await ensureConnectIndexes();
    const rawBody = await req.text();
    const r = await receiveEvents({ headers: Object.fromEntries(req.headers), rawBody });
    for (const orgId of r.orgIds || []) after(() => processPending({ orgId, limit: 20 }).catch((e) => console.error("connect processing failed:", e?.message)));
    return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
  } catch (e) { console.error("connect webhook:", e?.message); return NextResponse.json({ error: "Temporary error." }, { status: 500 }); }
}
