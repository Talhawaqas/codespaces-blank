// app/api/orgs/crm/deals/[dealId]/transition/route.js
//
// POST /api/orgs/crm/deals/:dealId/transition
// Body: { orgId, action, note? } — action is one of: advance, regress, win, lose, reopen
//
// Thin wrapper over transitionDeal() (src/lib/deal-workflow.js), same
// shape as every other transition route in this app.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionDeal } from "../../../../../../../lib/deal-workflow.js";

export async function POST(req, { params }) {
  try {
    const { dealId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionDeal({ orgId, dealId, action, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.deal.status, updatedAt: result.deal.updatedAt, closedAt: result.deal.closedAt || null });
  } catch (err) {
    console.error("orgs/crm/deals/[dealId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the deal's stage." }, { status: 500 });
  }
}
