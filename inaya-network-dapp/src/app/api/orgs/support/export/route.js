// GET /api/orgs/support/export?orgId=&format=json|csv&status=&since=&requesterEmail=&includeNotes=1
// Ticket export (export_tickets permission). Audited, integrity-hashed (X-Content-SHA256).
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { exportTickets } from "../../../../../lib/support/exporter.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req) {
  try {
    const q = new URL(req.url).searchParams;
    const orgId = q.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    try { await checkRateLimit({ action: "support:export", key: auth.session.email, max: 10, windowMs: 60 * 60 * 1000 }); } catch { return NextResponse.json({ error: "Too many exports. Please wait." }, { status: 429 }); }
    const r = await exportTickets({ orgId, membership: auth.membership, email: auth.session.email, format: q.get("format") || "json", filter: { status: q.get("status") || undefined, since: q.get("since") || undefined, requesterEmail: q.get("requesterEmail") || undefined, includeNotes: q.get("includeNotes") === "1" } });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return new NextResponse(r.content, { status: 200, headers: { "Content-Type": r.contentType, "Content-Disposition": `attachment; filename="${r.filename}"`, "X-Content-SHA256": r.sha256, "X-Export-Count": String(r.count), "X-Export-Truncated": String(r.truncated), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) { console.error("support export failed:", err?.message); return NextResponse.json({ error: "Something went wrong." }, { status: 500 }); }
}
