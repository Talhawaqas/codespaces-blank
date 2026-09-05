// app/api/orgs/health/care-team/route.js
// POST { orgId, patientId, memberEmail, role } -> assign a care-team member

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { assignCareTeamMember } from "../../../../../lib/health-patients.js";

export async function POST(req) {
  try {
    const { orgId, patientId, memberEmail, role } = await req.json();
    if (!orgId || !patientId || !memberEmail) return NextResponse.json({ error: "orgId, patientId, and memberEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await assignCareTeamMember({ orgId, patientId, memberEmail, role, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ assigned: true });
  } catch (err) {
    console.error("orgs/health/care-team POST failed:", err);
    return NextResponse.json({ error: "Could not assign care-team member." }, { status: 500 });
  }
}
