// app/api/orgs/admin-dashboard/route.js -- GET ?orgId  the admin dashboard (owner/admin or an administrator role, auditors read-only).
// Tiles carry an honest state: OK, ATTENTION, NO_DATA, NOT_ENABLED or UNKNOWN with the coverage limitation. Nothing is estimated.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { buildDashboard, DashError } from "../../../../lib/admin/dashboard.js";
export const dynamic = "force-dynamic";
export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId"); if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    return NextResponse.json(await buildDashboard({ orgId, membership: auth.membership }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof DashError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("admin-dashboard failed:", err?.name, String(err?.message || "").slice(0, 200)); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
