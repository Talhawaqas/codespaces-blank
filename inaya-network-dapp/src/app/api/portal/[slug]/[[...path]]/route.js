// Customer portal API (Customer Portal SOW). The organization is resolved ONLY from the slug; the customer session
// is looked up against that organization. Logic and rules live in src/lib/support/portalApi.js.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { orgBySlug } from "../../../../../lib/support/settings.js";
import { handlePortal, MUTATING } from "../../../../../lib/support/portalApi.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const MAX_JSON = 256 * 1024;

const clientIp = (req) => (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

async function handle(req, ctx) {
  try {
    const { slug, path = [] } = await ctx.params;
    await ensureOrgIndexes();
    const org = await orgBySlug(slug);
    if (!org) return NextResponse.json({ error: "This portal does not exist." }, { status: 404 });
    const url = new URL(req.url);
    let body = {};
    if (MUTATING(req.method)) {
      if (Number(req.headers.get("content-length") || 0) > MAX_JSON) return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
      try { const text = await req.text(); if (text.length > MAX_JSON) return NextResponse.json({ error: "Request body is too large." }, { status: 413 }); body = text ? JSON.parse(text) : {}; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    }
    const r = await handlePortal({ method: req.method, path, query: Object.fromEntries(url.searchParams.entries()), body, req, org, ip: clientIp(req) });
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    if (r?.error) return NextResponse.json({ error: r.error, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}) }, { status: r.status || 400, headers });
    const res = NextResponse.json(r.setCookie ? r.data : r, { status: 200, headers });
    if (r.setCookie) res.headers.append("Set-Cookie", r.setCookie);
    return res;
  } catch (err) { console.error(`portal ${req.method} ${req.url} failed:`, err?.message || err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
export const GET = handle; export const POST = handle; export const PUT = handle; export const PATCH = handle; export const DELETE = handle;
