// app/api/orgs/regulated/exceptions/[exceptionId]/transition/route.js
// PATCH { orgId, action, expiresAt? } -> approve / activate / renew / close

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionException } from "../../../../../../../lib/compliance-exceptions.js";

function serialize(e) {
  return { id: e._id.toString(), status: e.status, riskAcceptedByEmail: e.riskAcceptedByEmail, expiresAt: e.expiresAt };
}

export async function PATCH(req, { params }) {
  try {
    const { exceptionId } = await params;
    const { orgId, action, expiresAt } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionException({ orgId, exceptionId, action, expiresAt, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ exception: serialize(result.exception) });
  } catch (err) {
    console.error("orgs/regulated/exceptions/[exceptionId]/transition PATCH failed:", err);
    return NextResponse.json({ error: "Could not update exception." }, { status: 500 });
  }
}
