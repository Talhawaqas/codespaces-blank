// POST /api/orgs/rds/instances/:instanceId/query  { orgId, sql, readOnly? }
// The SQL Query Editor over a Workstream-A-hosted database (distinct from legacyDataAccess/sqlGateway.js).
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../../../lib/rateLimit.js";
import { runQuery } from "../../../../../../../lib/rds/instances.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req, ctx) {
  try {
    const { instanceId } = await ctx.params;
    const { orgId, sql, readOnly } = await req.json();
    if (!orgId || !sql) return NextResponse.json({ error: "orgId and sql are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    try { await checkRateLimit({ action: "rds:query", key: auth.session.email, max: 60, windowMs: 15 * 60 * 1000 }); } catch { return NextResponse.json({ error: "Too many queries. Please wait a moment." }, { status: 429 }); }
    const r = await runQuery({ orgId, membership: auth.membership, actorEmail: auth.session.email, instanceId, sql, readOnly: readOnly !== false });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("rds query failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
