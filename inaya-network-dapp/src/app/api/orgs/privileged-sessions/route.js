// app/api/orgs/privileged-sessions/route.js
// GET  ?orgId=&status=&grantType= -> list privileged access sessions
// POST { orgId, action: "request" | "breakGlass", role?, reason, scope, requestedHours?/hours? } -> start a session

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requestElevation, grantBreakGlass, listSessions } from "../../../../lib/privileged-access.js";

function serialize(s) {
  return {
    id: s._id.toString(), grantType: s.grantType, role: s.role, reason: s.reason, scope: s.scope,
    requestedHours: s.requestedHours, requestedByEmail: s.requestedByEmail,
    approvedByEmail: s.approvedByEmail, approvedAt: s.approvedAt, expiresAt: s.expiresAt,
    status: s.status, reviewedAt: s.reviewedAt, reviewedByEmail: s.reviewedByEmail, attestation: s.attestation,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const sessions = await listSessions(orgId, { status: searchParams.get("status") || undefined, grantType: searchParams.get("grantType") || undefined });
    return NextResponse.json({ sessions: sessions.map(serialize) });
  } catch (err) {
    console.error("orgs/privileged-sessions GET failed:", err);
    return NextResponse.json({ error: "Could not fetch privileged sessions." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, action, reason, scope } = body;
    if (!orgId || !action || !reason || !scope) return NextResponse.json({ error: "orgId, action, reason, and scope are required." }, { status: 400 });
    if (!["request", "breakGlass"].includes(action)) return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const impl = action === "request" ? requestElevation : grantBreakGlass;
    const result = await impl({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ session: serialize(result.session) });
  } catch (err) {
    console.error("orgs/privileged-sessions POST failed:", err);
    return NextResponse.json({ error: "Could not create privileged session." }, { status: 500 });
  }
}
