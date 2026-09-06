// app/api/orgs/privileged-sessions/[sessionId]/route.js
// PATCH { orgId, action: "approve" | "reject" | "revoke" | "review", ... } -> manage a privileged session

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { approveElevation, rejectElevation, revokeSession, reviewSession } from "../../../../../lib/privileged-access.js";

const ACTIONS = { approve: approveElevation, reject: rejectElevation, revoke: revokeSession, review: reviewSession };

function serialize(s) {
  return { id: s._id.toString(), status: s.status, approvedByEmail: s.approvedByEmail, expiresAt: s.expiresAt, reviewedAt: s.reviewedAt, attestation: s.attestation };
}

export async function PATCH(req, { params }) {
  try {
    const { sessionId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });
    const impl = ACTIONS[action];
    if (!impl) return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await impl({ ...body, sessionId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ session: serialize(result.session) });
  } catch (err) {
    console.error("orgs/privileged-sessions/[sessionId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update privileged session." }, { status: 500 });
  }
}
