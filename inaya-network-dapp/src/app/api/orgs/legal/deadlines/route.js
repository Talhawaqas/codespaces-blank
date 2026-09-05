// app/api/orgs/legal/deadlines/route.js
// GET   ?orgId=&matterId= -> list deadlines for a matter
// POST  { orgId, matterId, description, dueAt, ... } -> create deadline
// PATCH { orgId, deadlineId } -> confirm an unconfirmed (externally-synced) deadline

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createDeadline, confirmDeadline, listDeadlinesForMatter } from "../../../../../lib/legal-calendar.js";

function serialize(d) {
  return { id: d._id.toString(), description: d.description, dueAt: d.dueAt, jurisdiction: d.jurisdiction, court: d.court, confidence: d.confidence, manualConfirmation: d.manualConfirmation, source: d.source };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const matterId = searchParams.get("matterId");
    if (!orgId || !matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const deadlines = await listDeadlinesForMatter(orgId, matterId);
    return NextResponse.json({ deadlines: deadlines.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/deadlines GET failed:", err);
    return NextResponse.json({ error: "Could not fetch deadlines." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.matterId || !body.description || !body.dueAt) return NextResponse.json({ error: "orgId, matterId, description, and dueAt are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(body.orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createDeadline({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ deadline: serialize(result.deadline) });
  } catch (err) {
    console.error("orgs/legal/deadlines POST failed:", err);
    return NextResponse.json({ error: "Could not create deadline." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, deadlineId } = await req.json();
    if (!orgId || !deadlineId) return NextResponse.json({ error: "orgId and deadlineId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await confirmDeadline({ orgId, deadlineId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ deadline: serialize(result.deadline) });
  } catch (err) {
    console.error("orgs/legal/deadlines PATCH failed:", err);
    return NextResponse.json({ error: "Could not confirm deadline." }, { status: 500 });
  }
}
