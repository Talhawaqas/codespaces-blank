// app/api/orgs/nas/shares/[shareId]/route.js
// GET ?orgId= -> detail; DELETE ?orgId=&purgeData=true|false -> real share removal from the appliance

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getShare, deleteShare } from "../../../../../../lib/nas/shares.js";

export async function GET(req, { params }) {
  try {
    const { shareId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getShare({ orgId, shareId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/shares/[shareId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch NAS share." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { shareId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const purgeData = searchParams.get("purgeData") === "true";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteShare({ orgId, shareId, purgeData, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/shares/[shareId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete NAS share." }, { status: 500 });
  }
}
