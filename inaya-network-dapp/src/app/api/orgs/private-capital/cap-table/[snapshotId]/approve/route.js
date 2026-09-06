// app/api/orgs/private-capital/cap-table/[snapshotId]/approve/route.js
// PATCH { orgId } -> a second, independent reviewer approves a cap-table snapshot (never the recorder)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { approveCapTableSnapshot } from "../../../../../../../lib/cap-table.js";

export async function PATCH(req, { params }) {
  try {
    const { snapshotId } = await params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await approveCapTableSnapshot({ orgId, snapshotId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ snapshot: { id: result.snapshot._id.toString(), approvedByEmail: result.snapshot.approvedByEmail, approvedAt: result.snapshot.approvedAt } });
  } catch (err) {
    console.error("orgs/private-capital/cap-table/[snapshotId]/approve PATCH failed:", err);
    return NextResponse.json({ error: "Could not approve cap-table snapshot." }, { status: 500 });
  }
}
