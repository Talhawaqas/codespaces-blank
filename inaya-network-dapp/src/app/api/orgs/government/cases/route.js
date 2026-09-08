// app/api/orgs/government/cases/route.js
// GET  ?orgId=&status=&category=&department= -> list cases (need-to-know filtered for staff)
// POST { orgId, category, priority, title, description, department, citizenRecordId, attachmentIds, ownerEmail } -> open a case

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createCase, listCases } from "../../../../../lib/government-cases.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await listCases(orgId, { status: searchParams.get("status") || undefined, category: searchParams.get("category") || undefined, department: searchParams.get("department") || undefined, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/government/cases GET failed:", err);
    return NextResponse.json({ error: "Could not fetch cases." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, category, priority, title } = body;
    if (!orgId || !category || !priority || !title) return NextResponse.json({ error: "orgId, category, priority, and title are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createCase({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ case: result.case });
  } catch (err) {
    console.error("orgs/government/cases POST failed:", err);
    return NextResponse.json({ error: "Could not open the case." }, { status: 500 });
  }
}
