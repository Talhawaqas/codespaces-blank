// app/api/orgs/nas/users/route.js
// GET ?orgId=&applianceId= -> list; POST { orgId, applianceId, memberEmail } -> real appliance-side SMB user provisioning

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { provisionNasUser, listNasUsers } from "../../../../../lib/nas/users.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const applianceId = searchParams.get("applianceId") || undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listNasUsers({ orgId, applianceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/users GET failed:", err);
    return NextResponse.json({ error: "Could not list NAS users." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, applianceId, memberEmail } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await provisionNasUser({ orgId, applianceId, memberEmail, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("orgs/nas/users POST failed:", err);
    return NextResponse.json({ error: "Could not provision NAS user." }, { status: 500 });
  }
}
