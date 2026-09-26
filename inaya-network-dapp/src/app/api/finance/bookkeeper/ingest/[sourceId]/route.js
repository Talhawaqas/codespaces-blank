// POST /api/finance/bookkeeper/ingest/:sourceId  (AI Bookkeeper SOW sections 9, 35)
// Signed relay for email and API sources. Authenticated by signature only: X-Inaya-Timestamp + X-Inaya-Signature (v1=HMAC-SHA256 of
// "<timestamp>.<raw body>" with the source's ingest secret). The SOURCE names the organization and department; the body never can.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { getSourceById } from "../../../../../../lib/bookkeeper/sources.js";
import { ingestSigned, MAX_BODY_BYTES } from "../../../../../../lib/bookkeeper/inbound.js";
import { ensureBookkeeperIndexes } from "../../../../../../lib/bookkeeper/db.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const H = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(req, ctx) {
  try {
    const { sourceId } = await ctx.params;
    const url = new URL(req.url); const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")) !== "https" && !local) return NextResponse.json({ error: "HTTPS is required." }, { status: 400, headers: H });
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "The payload is too large." }, { status: 413, headers: H });
    const rawBody = await req.text();
    await ensureOrgIndexes(); await ensureBookkeeperIndexes();
    const source = await getSourceById(sourceId);
    const r = await ingestSigned({ source, headers: { "x-inaya-timestamp": req.headers.get("x-inaya-timestamp"), "x-inaya-signature": req.headers.get("x-inaya-signature") }, rawBody });
    return NextResponse.json(r.body, { status: r.status, headers: H });
  } catch (err) { console.error("bookkeeper ingest failed:", err?.message || err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers: H }); }
}
