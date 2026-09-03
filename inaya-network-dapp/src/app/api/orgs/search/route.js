// app/api/orgs/search/route.js
//
// GET /api/orgs/search?orgId=&q=
//
// Enterprise OS SOW, Phase 4. Same auth shape as dashboard/route.js —
// requireMembership gates it, searchOrg (src/lib/orgSearch.js) does the
// actual work over getAccessibleScope()'s already permission-filtered
// data.

import { NextResponse } from "next/server";
import { requireMembership } from "../../../../lib/orgs.js";
import { searchOrg } from "../../../../lib/orgSearch.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    const query = url.searchParams.get("q") || "";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const results = await searchOrg({ orgId, membership: auth.membership, email: auth.session.email, query });
    return NextResponse.json({ results });
  } catch (err) {
    console.error("orgs/search failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
