// app/api/orgs/regulated/dashboard/route.js
// GET ?orgId= -> the Continuous Compliance dashboard. See compliance-health.js's header for
// why "unknown" must never be silently reported as "passing" — this route passes the
// aggregator's result through verbatim, it never re-interprets it.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance, canAccessAudit } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { getComplianceHealth } from "../../../../../lib/compliance-health.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessCompliance(auth.membership) && !canAccessAudit(auth.membership)) {
      return NextResponse.json({ error: "You don't have compliance or audit access." }, { status: 403 });
    }

    const health = await getComplianceHealth(orgId);
    return NextResponse.json(health);
  } catch (err) {
    console.error("orgs/regulated/dashboard GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the compliance dashboard." }, { status: 500 });
  }
}
