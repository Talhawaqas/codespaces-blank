// app/api/orgs/government/citizen-records/[recordId]/assign/route.js
// POST   { orgId, memberEmail, role } -> assign a member to this record's need-to-know list
// DELETE { orgId, memberEmail }       -> unassign

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { assignCitizenRecord, unassignCitizenRecord } from "../../../../../../../lib/citizen-records.js";

export async function POST(req, { params }) {
  try {
    const { recordId } = params;
    const body = await req.json();
    const { orgId, memberEmail } = body;
    if (!orgId || !memberEmail) return NextResponse.json({ error: "orgId and memberEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await assignCitizenRecord({ orgId, recordId, memberEmail, role: body.role, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/government/citizen-records/[recordId]/assign POST failed:", err);
    return NextResponse.json({ error: "Could not assign the citizen record." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { recordId } = params;
    const body = await req.json();
    const { orgId, memberEmail } = body;
    if (!orgId || !memberEmail) return NextResponse.json({ error: "orgId and memberEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await unassignCitizenRecord({ orgId, recordId, memberEmail, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/government/citizen-records/[recordId]/assign DELETE failed:", err);
    return NextResponse.json({ error: "Could not unassign the citizen record." }, { status: 500 });
  }
}
