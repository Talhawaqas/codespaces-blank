// app/api/orgs/private-capital/board-meetings/[meetingId]/resolutions/route.js
// GET  ?orgId= -> list resolutions for a meeting
// POST { orgId, title, description? } -> propose a new resolution

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { proposeResolution, listResolutions } from "../../../../../../../lib/board-management.js";

function serialize(r) {
  return { id: r._id.toString(), title: r.title, description: r.description, votes: r.votes, status: r.status, outcome: r.outcome };
}

export async function GET(req, { params }) {
  try {
    const { meetingId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await listResolutions(orgId, meetingId, auth.membership);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ resolutions: result.resolutions.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/board-meetings/[meetingId]/resolutions GET failed:", err);
    return NextResponse.json({ error: "Could not fetch resolutions." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { meetingId } = await params;
    const body = await req.json();
    const { orgId, title } = body;
    if (!orgId || !title) return NextResponse.json({ error: "orgId and title are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await proposeResolution({ ...body, meetingId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ resolution: serialize(result.resolution) });
  } catch (err) {
    console.error("orgs/private-capital/board-meetings/[meetingId]/resolutions POST failed:", err);
    return NextResponse.json({ error: "Could not propose resolution." }, { status: 500 });
  }
}
