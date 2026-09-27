// GET  /api/orgs/rds/instances/:instanceId/snapshots?orgId=            -- list backups/snapshots
// POST /api/orgs/rds/instances/:instanceId/snapshots  { orgId, recoveryTimeUnix }  -- point-in-time restore (destructive)
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { listSnapshots, restorePointInTime } from "../../../../../../../lib/rds/instances.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { instanceId } = await ctx.params;
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listSnapshots({ orgId, instanceId });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("rds snapshots list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req, ctx) {
  try {
    const { instanceId } = await ctx.params;
    const { orgId, recoveryTimeUnix } = await req.json();
    if (!orgId || !Number.isFinite(recoveryTimeUnix)) return NextResponse.json({ error: "orgId and recoveryTimeUnix are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await restorePointInTime({ orgId, membership: auth.membership, actorEmail: auth.session.email, instanceId, recoveryTimeUnix });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("rds pitr restore failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
