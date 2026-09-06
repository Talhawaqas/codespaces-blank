// app/api/orgs/regulated/policies/[policyId]/transition/route.js
// PATCH { orgId, action } where action is one of:
//   "edit"            { title?, body? }  -- only while DRAFT/IN_REVIEW
//   "submitForReview" | "approve" | "reject"
//   "publish"         { effectiveDate?, expiresAt? } -- the one-way DRAFT->live step, sets immutable:true
//   "acknowledge"     -- records the caller's own acknowledgement

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { updatePolicyDraft, transitionPolicy, publishPolicy, recordAcknowledgement } from "../../../../../../../lib/compliance-policies.js";

function serialize(p) {
  return {
    id: p._id.toString(), key: p.key, version: p.version, title: p.title, body: p.body,
    status: p.status, immutable: p.immutable, effectiveDate: p.effectiveDate, expiresAt: p.expiresAt,
    approvedByEmail: p.approvedByEmail,
  };
}

export async function PATCH(req, { params }) {
  try {
    const { policyId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const { session, membership } = auth;
    let result;
    if (action === "edit") {
      result = await updatePolicyDraft({ orgId, policyId, title: body.title, body: body.body, actorEmail: session.email, membership });
    } else if (action === "publish") {
      result = await publishPolicy({ orgId, policyId, effectiveDate: body.effectiveDate, expiresAt: body.expiresAt, actorEmail: session.email, membership });
    } else if (action === "acknowledge") {
      await recordAcknowledgement({ orgId, policyId, memberEmail: session.email, actorEmail: session.email });
      return NextResponse.json({ acknowledged: true });
    } else {
      result = await transitionPolicy({ orgId, policyId, action, actorEmail: session.email, membership, note: body.note });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ policy: serialize(result.policy) });
  } catch (err) {
    console.error("orgs/regulated/policies/[policyId]/transition PATCH failed:", err);
    return NextResponse.json({ error: "Could not update policy." }, { status: 500 });
  }
}
