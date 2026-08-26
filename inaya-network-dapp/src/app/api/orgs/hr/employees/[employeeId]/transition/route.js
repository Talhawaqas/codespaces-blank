// app/api/orgs/hr/employees/[employeeId]/transition/route.js
//
// POST /api/orgs/hr/employees/:employeeId/transition
// Body: { orgId, action, note? } — action is one of: activate, placeOnLeave, returnFromLeave, terminate

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionEmployee } from "../../../../../../../lib/employee-workflow.js";

export async function POST(req, { params }) {
  try {
    const { employeeId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionEmployee({ orgId, employeeId, action, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ employmentStatus: result.employee.employmentStatus, updatedAt: result.employee.updatedAt });
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the employee's status." }, { status: 500 });
  }
}
