// POST /api/help/ticket: a signed-in Inaya user (Business Workspace member) asks Inaya's own support desk for help.
// Body: { subject, description, type?, category?, orgId? (optional context, honored only for an organization the user belongs to), page?, idempotencyKey? }.
// The requester is ALWAYS the verified session email; the destination desk comes from the server (INAYA_SUPPORT_ORG_ID), never from the request.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, getSession, getRawSessionToken } from "../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../lib/rateLimit.js";
import { createHelpTicket } from "../../../../lib/help.js";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };
const MAX_JSON = 32 * 1024;

export async function POST(req) {
  try {
    await ensureOrgIndexes();
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Please sign in to contact support." }, { status: 401, headers: H });
    let body;
    try { const text = await req.text(); if (text.length > MAX_JSON) return NextResponse.json({ error: "That message is too long." }, { status: 413, headers: H }); body = JSON.parse(text || "{}"); }
    catch { return NextResponse.json({ error: "The request must be valid JSON." }, { status: 400, headers: H }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    try { await checkRateLimit({ action: "help:ticket", key: session.email, max: 5, windowMs: 60 * 60 * 1000 }); }
    catch { return NextResponse.json({ error: "You have sent several requests recently. Please wait a little before sending another." }, { status: 429, headers: H }); }
    const r = await createHelpTicket({ session, subject: body.subject, description: body.description, type: body.type, category: body.category, customerOrgId: body.orgId, page: body.page, idempotencyKey: body.idempotencyKey });
    if (r.error) return NextResponse.json({ error: r.error, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}) }, { status: r.status || 400, headers: H });
    return NextResponse.json(r, { status: r.duplicate ? 200 : 201, headers: H });
  } catch (err) {
    console.error("help/ticket failed:", err?.message || err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers: H });
  }
}
