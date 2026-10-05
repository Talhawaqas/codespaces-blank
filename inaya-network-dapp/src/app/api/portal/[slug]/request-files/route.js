// POST /api/portal/:slug/request-files?requestId=&itemId=&filename=   (raw bytes, up to 4 MB) -- a customer sends a file for an "upload" item of a request addressed to them.
// Same protections as the rest of the portal: the organization comes from the slug, the customer session is for THAT organization, the request must be addressed to the
// signed-in customer's own address, and mutating calls need the X-Portal-Request header and a same-origin Origin.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { orgBySlug } from "../../../../../lib/support/settings.js";
import { getPortalUser } from "../../../../../lib/support/portalAuth.js";
import { csrfCheck } from "../../../../../lib/support/portalApi.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import * as PR from "../../../../../lib/support/portalRequests.js";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const H = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(req, ctx) {
  try {
    const { slug } = await ctx.params; await ensureOrgIndexes(); const org = await orgBySlug(slug); if (!org) return NextResponse.json({ error: "This portal does not exist." }, { status: 404 });
    const csrf = csrfCheck(req); if (csrf) return NextResponse.json({ error: csrf.error }, { status: csrf.status, headers: H });
    const orgId = String(org.orgId); const user = await getPortalUser({ req, orgId }); if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401, headers: H });
    if (Number(req.headers.get("content-length") || 0) > PR.LIMITS.fileBytes + 1024) return NextResponse.json({ error: "A file can be at most 4 MB here." }, { status: 413, headers: H });
    try { await checkRateLimit({ action: `support:preq:upload:${orgId}`, key: String(user._id), max: 40, windowMs: 3600_000 }); } catch { return NextResponse.json({ error: "You're doing that too often. Please wait a little." }, { status: 429, headers: H }); }
    const q = new URL(req.url).searchParams; const buf = Buffer.from(await req.arrayBuffer());
    const settings = org.settings; settings.portalSlug = org.portalSlug;
    const r = await PR.customerUpload({ orgId, settings, user, requestId: q.get("requestId"), itemId: q.get("itemId"), filename: q.get("filename"), buffer: buf });
    if (r?.error) return NextResponse.json({ error: r.error, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}) }, { status: r.status || 400, headers: H });
    return NextResponse.json(r, { headers: H });
  } catch (err) { console.error("portal request upload failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers: H }); }
}
