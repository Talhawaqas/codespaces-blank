// app/api/orgs/trust-relationships/[relationshipId]/route.js
//
// PATCH /api/orgs/trust-relationships/:relationshipId
// Body: { orgId, action: "accept"|"reject"|"revoke" }
//
// "accept"/"reject" only succeed when orgId is the relationship's TO org
// (independent-control requirement, enforced inside org-trust.js's own
// findOneAndUpdate filter — this route does not need to re-check which
// side orgId is on). "revoke" succeeds from either side.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { acceptTrustRelationship, rejectTrustRelationship, revokeTrustRelationship } from "../../../../../lib/org-trust.js";

export async function PATCH(req, { params }) {
  try {
    const { relationshipId } = params;
    const { orgId, action } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });
    if (!["accept", "reject", "revoke"].includes(action)) {
      return NextResponse.json({ error: `Unknown action "${action}". Valid actions: accept, reject, revoke.` }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = action === "accept"
      ? await acceptTrustRelationship({ relationshipId, toOrgId: orgId, membership: auth.membership, actorEmail: auth.session.email })
      : action === "reject"
        ? await rejectTrustRelationship({ relationshipId, toOrgId: orgId, membership: auth.membership, actorEmail: auth.session.email })
        : await revokeTrustRelationship({ relationshipId, orgId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/trust-relationships/[relationshipId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the trust relationship." }, { status: 500 });
  }
}
