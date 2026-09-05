// app/api/orgs/legal/conflict-checks/route.js
// GET  ?orgId=&names=a,b,c -> run a conflict search (read-only)
// POST { orgId, namesChecked, matches, status, notes } -> record the reviewed decision

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { searchConflicts, recordConflictCheck } from "../../../../../lib/legal-conflict-workflow.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const names = (searchParams.get("names") || "").split(",").map((n) => n.trim()).filter(Boolean);
    if (!orgId || !names.length) return NextResponse.json({ error: "orgId and at least one name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { matches } = await searchConflicts({ orgId, names });
    return NextResponse.json({ matches });
  } catch (err) {
    console.error("orgs/legal/conflict-checks GET failed:", err);
    return NextResponse.json({ error: "Could not run conflict search." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.status) return NextResponse.json({ error: "orgId and status are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await recordConflictCheck({ ...body, reviewerEmail: auth.session.email, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ conflictCheck: { id: result.conflictCheck._id.toString(), status: result.conflictCheck.status } });
  } catch (err) {
    console.error("orgs/legal/conflict-checks POST failed:", err);
    return NextResponse.json({ error: "Could not record conflict check." }, { status: 500 });
  }
}
