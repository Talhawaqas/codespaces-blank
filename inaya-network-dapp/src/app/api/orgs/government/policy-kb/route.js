// app/api/orgs/government/policy-kb/route.js
// GET  ?orgId=&status=&key= -> list entries
// POST { orgId, key, title, body, ownerEmail, reviewCycleDays } -> create a draft entry

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createEntryDraft, listEntries } from "../../../../../lib/policy-knowledge-base.js";

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

    const result = await listEntries(orgId, { status: searchParams.get("status") || undefined, key: searchParams.get("key") || undefined, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/government/policy-kb GET failed:", err);
    return NextResponse.json({ error: "Could not fetch policy knowledge base entries." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, key, title } = body;
    if (!orgId || !key || !title) return NextResponse.json({ error: "orgId, key, and title are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createEntryDraft({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ entry: result.entry });
  } catch (err) {
    console.error("orgs/government/policy-kb POST failed:", err);
    return NextResponse.json({ error: "Could not create the entry." }, { status: 500 });
  }
}
