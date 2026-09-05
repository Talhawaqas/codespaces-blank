// app/api/orgs/health/breakglass/route.js
// POST { orgId, patientId, reason, hours? } -> grant emergency access
// GET  ?orgId= -> list unreviewed grants (manager/owner view)
// PATCH { orgId, assignmentId, reviewNotes? } -> mark a grant reviewed

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { grantBreakGlassAccess, listUnreviewedBreakGlassGrants, reviewBreakGlassGrant } from "../../../../../lib/health-breakglass.js";

export async function POST(req) {
  try {
    const { orgId, patientId, reason, hours } = await req.json();
    if (!orgId || !patientId || !reason) return NextResponse.json({ error: "orgId, patientId, and reason are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await grantBreakGlassAccess({ orgId, patientId, actorEmail: auth.session.email, reason, hours });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/health/breakglass POST failed:", err);
    return NextResponse.json({ error: "Could not grant emergency access." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const grants = await listUnreviewedBreakGlassGrants(orgId);
    return NextResponse.json({ grants: grants.map((g) => ({ id: g._id.toString(), patientId: g.patientId.toString(), email: g.email, reason: g.reason, expiresAt: g.expiresAt, createdAt: g.createdAt })) });
  } catch (err) {
    console.error("orgs/health/breakglass GET failed:", err);
    return NextResponse.json({ error: "Could not fetch emergency access grants." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, assignmentId, reviewNotes } = await req.json();
    if (!orgId || !assignmentId) return NextResponse.json({ error: "orgId and assignmentId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await reviewBreakGlassGrant({ orgId, assignmentId, actorEmail: auth.session.email, reviewNotes });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ reviewed: true });
  } catch (err) {
    console.error("orgs/health/breakglass PATCH failed:", err);
    return NextResponse.json({ error: "Could not review emergency access grant." }, { status: 500 });
  }
}
