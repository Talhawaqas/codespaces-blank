// app/api/orgs/financial/counterparties/[counterpartyId]/transition/route.js
// PATCH { orgId, action } -> sendQuestionnaire / submitForRiskAssessment / submitForLegalReview / approve / reject / contract / beginMonitoring

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionCounterpartyOnboarding } from "../../../../../../../lib/financial-counterparties.js";

function serialize(c) {
  return { id: c._id.toString(), name: c.name, onboardingStatus: c.onboardingStatus };
}

export async function PATCH(req, { params }) {
  try {
    const { counterpartyId } = await params;
    const { orgId, action } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionCounterpartyOnboarding({ orgId, counterpartyId, action, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ counterparty: serialize(result.counterparty) });
  } catch (err) {
    console.error("orgs/financial/counterparties/[counterpartyId]/transition PATCH failed:", err);
    return NextResponse.json({ error: "Could not update counterparty." }, { status: 500 });
  }
}
