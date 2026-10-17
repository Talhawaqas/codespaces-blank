// app/api/orgs/hr/org-chart/route.js
//
// GET /api/orgs/hr/org-chart?orgId=...
//   -> reporting-line tree built from exactly the employees the caller can
//      already see in the Employees list (getAccessibleScope), so the chart
//      never reveals anyone that list wouldn't. See lib/hr-structure.js.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { buildOrgChart } from "../../../../../lib/hr-structure.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const visible = scope.visibleEmployees.filter((e) => !e.deletedAt);
    return NextResponse.json({ roots: buildOrgChart(visible), employeeCount: visible.length });
  } catch (err) {
    console.error("orgs/hr/org-chart GET failed:", err);
    return NextResponse.json({ error: "Could not build the org chart." }, { status: 500 });
  }
}
