// app/api/orgs/regulated/findings/[findingId]/management-response/route.js
// POST { orgId, response } -> add a management response to the finding's timeline

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { addManagementResponse } from "../../../../../../../lib/internal-audit.js";

function serialize(f) {
  return { id: f._id.toString(), status: f.status, timeline: f.timeline };
}

export async function POST(req, { params }) {
  try {
    const { findingId } = await params;
    const { orgId, response } = await req.json();
    if (!orgId || !response) return NextResponse.json({ error: "orgId and response are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await addManagementResponse({ orgId, findingId, response, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ finding: serialize(result.finding) });
  } catch (err) {
    console.error("orgs/regulated/findings/[findingId]/management-response POST failed:", err);
    return NextResponse.json({ error: "Could not add management response." }, { status: 500 });
  }
}
