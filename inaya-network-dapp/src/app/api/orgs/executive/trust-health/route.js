// app/api/orgs/executive/trust-health/route.js
// GET ?orgId= -> Trust Health 2.0 -- ten dimensions, each honestly scored or explicitly unknown

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { computeTrustHealth2 } from "../../../../../lib/trust-health-v2.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await computeTrustHealth2(orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/executive/trust-health GET failed:", err);
    return NextResponse.json({ error: "Could not compute Trust Health 2.0." }, { status: 500 });
  }
}
