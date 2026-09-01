// app/api/orgs/brief/route.js
//
// GET /api/orgs/brief?orgId=&period=daily|weekly|monthly|yearly
// Thin wrapper over business-brief.js's generateBusinessBrief() — same
// requireMembership() gate every other org route uses; the real
// permission scoping happens inside computeBusinessInsights() ->
// getAccessibleScope(), not here.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { generateBusinessBrief } from "../../../../lib/business-brief.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const period = searchParams.get("period") || "weekly";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });

    const brief = await generateBusinessBrief({
      orgId, membership: auth.membership, email: auth.session.email, period, orgName: org?.name,
    });
    if (brief.error) return NextResponse.json(brief, { status: 400 });
    return NextResponse.json(brief);
  } catch (err) {
    console.error("orgs/brief GET failed:", err);
    return NextResponse.json({ error: "Could not generate the business brief." }, { status: 500 });
  }
}
