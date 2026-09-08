// app/api/orgs/government/cases/[caseId]/route.js
// GET ?orgId= -> a single case (citizen-record link access checked if linked)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { getCase } from "../../../../../../lib/government-cases.js";

export async function GET(req, { params }) {
  try {
    const { caseId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await getCase({ orgId, caseId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ case: result.case });
  } catch (err) {
    console.error("orgs/government/cases/[caseId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the case." }, { status: 500 });
  }
}
