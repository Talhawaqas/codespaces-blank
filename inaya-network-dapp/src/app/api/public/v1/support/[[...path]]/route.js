// Public support API (Customer Portal SOW §28). Bearer support-kind API key; see src/lib/support/publicApi.js.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { handlePublic } from "../../../../../../lib/support/publicApi.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const MAX_JSON = 6 * 1024 * 1024;

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params;
    await ensureOrgIndexes();
    const url = new URL(req.url);
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (Number(req.headers.get("content-length") || 0) > MAX_JSON) return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
      try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    }
    const r = await handlePublic({ method: req.method, path, query: Object.fromEntries(url.searchParams.entries()), body, req });
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (r?.error) return NextResponse.json({ error: r.error, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}) }, { status: r.status || 400, headers });
    const { status, ...rest } = r;
    return NextResponse.json(rest, { status: status || 200, headers });
  } catch (err) { console.error(`support api ${req.method} ${req.url} failed:`, err?.message || err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
export const GET = handle; export const POST = handle;
