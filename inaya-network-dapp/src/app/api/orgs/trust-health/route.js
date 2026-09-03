// app/api/orgs/trust-health/route.js
//
// GET /api/orgs/trust-health?orgId=...
//
// Enterprise OS SOW, Phase 2. Same auth/aggregation shape as
// dashboard/route.js: requireMembership gates it, computeTrustHealthSnapshot
// does the actual aggregation (src/lib/trustHealth.js) — this route is a
// thin wrapper, no logic of its own.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { computeTrustHealthSnapshot } from "../../../../lib/trustHealth.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const snapshot = await computeTrustHealthSnapshot({
      scope: "org",
      orgId,
      membership: auth.membership,
      email: auth.session.email,
    });
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error("orgs/trust-health failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
