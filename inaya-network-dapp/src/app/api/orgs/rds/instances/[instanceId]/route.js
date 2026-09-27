// GET    /api/orgs/rds/instances/:instanceId?orgId=                       -- live status (polls the provider)
// PATCH  /api/orgs/rds/instances/:instanceId  { orgId, action: start|stop } -- lifecycle
// DELETE /api/orgs/rds/instances/:instanceId  { orgId, confirmName }        -- permanent, requires typing the name
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getInstanceStatus, startInstance, stopInstance, deprovisionInstance } from "../../../../../../lib/rds/instances.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req, ctx) {
  try {
    const { instanceId } = await ctx.params;
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await getInstanceStatus({ orgId, instanceId });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("rds instance status failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function PATCH(req, ctx) {
  try {
    const { instanceId } = await ctx.params;
    const { orgId, action } = await req.json();
    if (!orgId || !["start", "stop"].includes(action)) return NextResponse.json({ error: "orgId and action (start|stop) are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const fn = action === "start" ? startInstance : stopInstance;
    const r = await fn({ orgId, membership: auth.membership, actorEmail: auth.session.email, instanceId });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("rds instance lifecycle action failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function DELETE(req, ctx) {
  try {
    const { instanceId } = await ctx.params;
    const { orgId, confirmName } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await deprovisionInstance({ orgId, membership: auth.membership, actorEmail: auth.session.email, instanceId, confirmName });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("rds instance delete failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
