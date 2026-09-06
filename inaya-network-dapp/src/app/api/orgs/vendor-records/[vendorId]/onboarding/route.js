// app/api/orgs/vendor-records/[vendorId]/onboarding/route.js
// PATCH { orgId, action } -> sendQuestionnaire / submitEvidence / submitForRiskAssessment /
//   submitForLegalReview / submitForProcurement / approve / reject / contract / beginMonitoring

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { transitionVendorOnboarding } from "../../../../../../lib/vendor-management.js";

export async function PATCH(req, { params }) {
  try {
    const { vendorId } = await params;
    const { orgId, action } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionVendorOnboarding({ orgId, vendorId, action, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ vendor: { id: result.vendor._id.toString(), onboardingStatus: result.vendor.onboardingStatus } });
  } catch (err) {
    console.error("orgs/vendor-records/[vendorId]/onboarding PATCH failed:", err);
    return NextResponse.json({ error: "Could not update vendor onboarding." }, { status: 500 });
  }
}
