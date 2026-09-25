// app/api/orgs/nas/shares/route.js
// GET ?orgId=&applianceId= -> list; POST { orgId, applianceId, shareName, ownerUnixUser, quotaBytes } -> real share provisioning

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createShare, listShares } from "../../../../../lib/nas/shares.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const applianceId = searchParams.get("applianceId") || undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listShares({ orgId, applianceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/shares GET failed:", err);
    return NextResponse.json({ error: "Could not list NAS shares." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, applianceId, shareName, ownerUnixUser, quotaBytes } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createShare({ orgId, applianceId, shareName, ownerUnixUser, quotaBytes, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("orgs/nas/shares POST failed:", err);
    return NextResponse.json({ error: "Could not create NAS share." }, { status: 500 });
  }
}
