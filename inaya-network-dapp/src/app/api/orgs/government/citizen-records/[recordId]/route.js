// app/api/orgs/government/citizen-records/[recordId]/route.js
// GET ?orgId= -> full record content, gated by requireCitizenRecordAccess (need-to-know)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { requireCitizenRecordAccess } from "../../../../../../lib/citizen-records.js";

export async function GET(req, { params }) {
  try {
    const { recordId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const access = await requireCitizenRecordAccess({ orgId, recordId, membership: auth.membership, actorEmail: auth.session.email });
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

    return NextResponse.json({ record: access.record });
  } catch (err) {
    console.error("orgs/government/citizen-records/[recordId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the citizen record." }, { status: 500 });
  }
}
