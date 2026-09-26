// /api/finance/bookkeeper/whatsapp/:sourceId  (AI Bookkeeper SOW section 10)
// Meta WhatsApp Cloud API webhook. GET answers the verification challenge; POST needs X-Hub-Signature-256. STATUS: UNVERIFIED against a
// live WhatsApp Business account (see the documentation). The source names the organization; unlisted senders are refused.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { getSourceById } from "../../../../../../lib/bookkeeper/sources.js";
import { whatsappVerify, whatsappReceive } from "../../../../../../lib/bookkeeper/inbound.js";
import { ensureBookkeeperIndexes } from "../../../../../../lib/bookkeeper/db.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const H = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(req, ctx) {
  try {
    const { sourceId } = await ctx.params; await ensureOrgIndexes(); await ensureBookkeeperIndexes();
    const source = await getSourceById(sourceId);
    const r = whatsappVerify({ source, query: Object.fromEntries(new URL(req.url).searchParams.entries()) });
    return new NextResponse(r.text, { status: r.status, headers: { ...H, "Content-Type": "text/plain" } });
  } catch (err) { console.error("whatsapp verify failed:", err?.message || err); return new NextResponse("Forbidden", { status: 403, headers: H }); }
}

export async function POST(req, ctx) {
  try {
    const { sourceId } = await ctx.params;
    if (Number(req.headers.get("content-length") || 0) > 1024 * 1024) return NextResponse.json({ error: "The payload is too large." }, { status: 413, headers: H });
    const rawBody = await req.text(); await ensureOrgIndexes(); await ensureBookkeeperIndexes();
    const source = await getSourceById(sourceId);
    const r = await whatsappReceive({ source, headers: { "x-hub-signature-256": req.headers.get("x-hub-signature-256") }, rawBody });
    return NextResponse.json(r.body, { status: r.status, headers: H });
  } catch (err) { console.error("whatsapp webhook failed:", err?.message || err); return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: H }); }
}
