// app/api/orgs/nas/appliances/[applianceId]/route.js
// GET ?orgId= -> detail; DELETE ?orgId= -> soft delete (blocked if active shares exist)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getAppliance, deleteAppliance } from "../../../../../../lib/nas/appliances.js";

export async function GET(req, { params }) {
  try {
    const { applianceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getAppliance({ orgId, applianceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/appliances/[applianceId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch NAS appliance." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { applianceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteAppliance({ orgId, applianceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/appliances/[applianceId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete NAS appliance." }, { status: 500 });
  }
}
