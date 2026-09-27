// GET  /api/orgs/rds/instances?orgId=                -- list instances + which providers are configured
// POST /api/orgs/rds/instances  { orgId, providerName, name, organizationSlug, region?, dbPassword, highAvailability? }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listInstances, provisionInstance, listConfiguredProviders } from "../../../../../lib/rds/instances.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listInstances({ orgId });
    return NextResponse.json({ ...r, availableProviders: listConfiguredProviders() });
  } catch (err) { console.error("rds instances list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req) {
  try {
    const body = await req.json(); const { orgId, providerName, name, organizationSlug, region, dbPassword, highAvailability } = body || {};
    if (!orgId || !providerName || !name || !dbPassword) return NextResponse.json({ error: "orgId, providerName, name and dbPassword are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await provisionInstance({ orgId, membership: auth.membership, actorEmail: auth.session.email, providerName, name, organizationSlug, region, dbPassword, highAvailability });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("rds instance provision failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
