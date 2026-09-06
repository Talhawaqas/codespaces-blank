// app/api/orgs/private-capital/fundraising/[prospectId]/convert/route.js
// POST { orgId, entityType?, jurisdiction?, accreditationStatus? } -> the only path from LEGAL_DOCS to
// CLOSED; creates a real financial-investors.js Investor record

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { convertToInvestor } from "../../../../../../../lib/fundraising.js";

export async function POST(req, { params }) {
  try {
    const { prospectId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await convertToInvestor({ ...body, prospectId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      prospect: { id: result.prospect._id.toString(), stage: result.prospect.stage },
      investor: { id: result.investor._id.toString(), legalName: result.investor.legalName },
    });
  } catch (err) {
    console.error("orgs/private-capital/fundraising/[prospectId]/convert POST failed:", err);
    return NextResponse.json({ error: "Could not convert prospect to investor." }, { status: 500 });
  }
}
