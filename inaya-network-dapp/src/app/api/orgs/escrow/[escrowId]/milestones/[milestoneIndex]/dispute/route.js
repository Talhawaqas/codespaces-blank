// app/api/orgs/escrow/[escrowId]/milestones/[milestoneIndex]/dispute/route.js
// POST { orgId, reason?, documentRef? } -- stops release cold until resolved.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessEscrow } from "../../../../../../../../lib/orgs.js";
import { disputeMilestone } from "../../../../../../../../lib/escrow-workflow.js";

export async function POST(req, { params }) {
  try {
    const { escrowId, milestoneIndex } = params;
    const { orgId, reason, documentRef } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessEscrow(auth.membership)) return NextResponse.json({ error: "You don't have escrow access." }, { status: 403 });

    const result = await disputeMilestone({ orgId, escrowId, milestoneIndex: Number(milestoneIndex), reason, documentRef, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ status: result.escrow.status });
  } catch (err) {
    console.error("orgs/escrow milestone dispute POST failed:", err);
    return NextResponse.json({ error: "Could not file the dispute." }, { status: 500 });
  }
}
