// app/api/orgs/private-capital/spvs/[spvId]/expenses/route.js
// POST { orgId, description, amount } -> record an expense (append-only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordExpense } from "../../../../../../../lib/spv-management.js";

export async function POST(req, { params }) {
  try {
    const { spvId } = await params;
    const body = await req.json();
    const { orgId, description, amount } = body;
    if (!orgId || !description || typeof amount !== "number") return NextResponse.json({ error: "orgId, description, and a numeric amount are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordExpense({ orgId, spvId, description, amount, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ expenses: result.spv.expenses });
  } catch (err) {
    console.error("orgs/private-capital/spvs/[spvId]/expenses POST failed:", err);
    return NextResponse.json({ error: "Could not record expense." }, { status: 500 });
  }
}
