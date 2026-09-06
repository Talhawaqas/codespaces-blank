// app/api/orgs/private-capital/exits/[exitId]/begin-closing/route.js
// PATCH { orgId } -> only reachable from IC_APPROVED

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { beginClosing } from "../../../../../../../lib/exit-management.js";

export async function PATCH(req, { params }) {
  try {
    const { exitId } = await params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await beginClosing({ orgId, exitId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ exit: { id: result.exit._id.toString(), status: result.exit.status } });
  } catch (err) {
    console.error("orgs/private-capital/exits/[exitId]/begin-closing PATCH failed:", err);
    return NextResponse.json({ error: "Could not begin closing." }, { status: 500 });
  }
}
