// app/api/orgs/regulated/exceptions/route.js
// GET  ?orgId=&status= -> list compliance exceptions
// POST { orgId, linkedControlId?, justification, compensatingControl?, expiresAt } -> request an exception

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { requestException, listExceptions } from "../../../../../lib/compliance-exceptions.js";

function serialize(e) {
  return {
    id: e._id.toString(), linkedControlId: e.linkedControlId?.toString() || null, justification: e.justification,
    compensatingControl: e.compensatingControl, status: e.status, riskAcceptedByEmail: e.riskAcceptedByEmail,
    expiresAt: e.expiresAt, requestedByEmail: e.requestedByEmail,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessCompliance(auth.membership)) return NextResponse.json({ error: "You don't have compliance access." }, { status: 403 });

    const exceptions = await listExceptions(orgId, { status: searchParams.get("status") || undefined });
    return NextResponse.json({ exceptions: exceptions.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/exceptions GET failed:", err);
    return NextResponse.json({ error: "Could not fetch exceptions." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, justification, expiresAt } = body;
    if (!orgId || !justification || !expiresAt) return NextResponse.json({ error: "orgId, justification, and expiresAt are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await requestException({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ exception: serialize(result.exception) });
  } catch (err) {
    console.error("orgs/regulated/exceptions POST failed:", err);
    return NextResponse.json({ error: "Could not request exception." }, { status: 500 });
  }
}
