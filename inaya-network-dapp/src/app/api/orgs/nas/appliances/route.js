// app/api/orgs/nas/appliances/route.js
// GET ?orgId= -> list; POST { orgId, name, backend, host, adminUsername, adminPassword } -> register + health check

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { registerAppliance, listAppliances } from "../../../../../lib/nas/appliances.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listAppliances({ orgId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/appliances GET failed:", err);
    return NextResponse.json({ error: "Could not list NAS appliances." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, name, backend, host, adminUsername, adminPassword } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await registerAppliance({ orgId, name, backend, host, adminUsername, adminPassword, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("orgs/nas/appliances POST failed:", err);
    return NextResponse.json({ error: "Could not register NAS appliance." }, { status: 500 });
  }
}
