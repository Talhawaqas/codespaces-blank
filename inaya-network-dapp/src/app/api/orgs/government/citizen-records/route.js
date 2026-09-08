// app/api/orgs/government/citizen-records/route.js
// GET  ?orgId=&status=&department= -> list citizen records (metadata only, need-to-know applies per-record on open)
// POST { orgId, legalName, preferredName, dateOfBirth, identifiers, contacts, demographics, department, classification } -> create

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createCitizenRecord, listCitizenRecords } from "../../../../../lib/citizen-records.js";

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

    const result = await listCitizenRecords(orgId, { status: searchParams.get("status") || undefined, department: searchParams.get("department") || undefined, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/government/citizen-records GET failed:", err);
    return NextResponse.json({ error: "Could not fetch citizen records." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, legalName } = body;
    if (!orgId || !legalName) return NextResponse.json({ error: "orgId and legalName are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createCitizenRecord({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ record: result.record });
  } catch (err) {
    console.error("orgs/government/citizen-records POST failed:", err);
    return NextResponse.json({ error: "Could not create citizen record." }, { status: 500 });
  }
}
