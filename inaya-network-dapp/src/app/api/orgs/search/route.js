// app/api/orgs/search/route.js
//
// GET /api/orgs/search?orgId=&q=[&classification=&locked=1&legalHold=1&type=pdf&favorite=1&pinned=1&tag=]
//
// Unified search (Competitive Expansion SOW H). Same auth shape as before (requireMembership); unifiedSearch (src/lib/search/unified.js) wraps the original
// searchOrg, whose only data source is the permission-filtered getAccessibleScope(), and adds metadata, classification, your tags, shares, file requests,
// data rooms (managers) and page navigation. `results` keeps its shape; `tiers` states what is and is not searched (encrypted content is local-only).

import { NextResponse } from "next/server";
import { requireMembership } from "../../../../lib/orgs.js";
import { unifiedSearch } from "../../../../lib/search/unified.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    const query = url.searchParams.get("q") || "";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const p = url.searchParams; const flag = (k) => p.get(k) === "1";
    const filters = { classification: p.get("classification") || undefined, locked: flag("locked"), legalHold: flag("legalHold"), type: p.get("type") || undefined, favorite: flag("favorite"), pinned: flag("pinned"), tag: p.get("tag") || undefined };
    const { results, tiers } = await unifiedSearch({ orgId, membership: auth.membership, email: auth.session.email, query, filters });
    return NextResponse.json({ results, tiers });
  } catch (err) {
    console.error("orgs/search failed:", err);
    return NextResponse.json({ error: "Search failed. Please try again." }, { status: 500 });
  }
}
