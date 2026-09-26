// POST /api/support/inbound-email/:slug -- inbound email intake (Customer Portal SOW §11).
//
// Trust model, stated plainly: this endpoint accepts a delivery ONLY when it carries a valid HMAC signature
// (X-Inaya-Signature = hex HMAC-SHA256(secret, `${X-Inaya-Timestamp}.${rawBody}`)) made with the per-organization
// inbound secret and a timestamp within 5 minutes. The secret is generated in the console and shown once. Whatever
// mail-routing service forwards messages here (a small relay or worker that posts the parsed message) holds that
// secret; nothing on the open internet can inject a ticket. Threading, sender and authentication checks are then
// applied by lib/support/inbound.js. Not verified against a live mail provider from this codebase.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { orgBySlug } from "../../../../../lib/support/settings.js";
import { verifyInboundSignature, processInbound } from "../../../../../lib/support/inbound.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req, ctx) {
  try {
    const { slug } = await ctx.params;
    await ensureOrgIndexes();
    const org = await orgBySlug(slug);
    if (!org) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const orgId = String(org.orgId);
    try { await checkRateLimit({ action: "support:inbound", key: orgId, max: 600, windowMs: 60 * 60 * 1000 }); } catch { return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 }); }
    const raw = await req.text();
    if (raw.length > (org.settings.email.maxBytes || 5242880) * 2) return NextResponse.json({ error: "Message too large." }, { status: 413 });
    const ok = await verifyInboundSignature({ orgId, rawBody: raw, timestamp: req.headers.get("x-inaya-timestamp"), signature: req.headers.get("x-inaya-signature") || "" });
    if (!ok) return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    let message; try { message = JSON.parse(raw); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
    org.settings.portalSlug = org.portalSlug;
    const r = await processInbound({ orgId, settings: org.settings, message });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json({ status: r.status, ticketId: r.ticketId || null, action: r.action || null, reason: r.reason || null, duplicate: !!r.duplicate });
  } catch (err) { console.error("inbound email failed:", err?.message); return NextResponse.json({ error: "Something went wrong." }, { status: 500 }); }
}
