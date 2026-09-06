// app/api/orgs/regulated/examinations/route.js
// GET  ?orgId=&status= -> list regulatory examinations
// POST { orgId, examinerOrgName, scope, dueDate } -> create an examination
// PATCH { orgId, examinationId, action } -> activate / beginReview / close

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAudit } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createExamination, listExaminations, transitionExamination } from "../../../../../lib/regulatory-examination.js";

function serialize(e) {
  return { id: e._id.toString(), examinerOrgName: e.examinerOrgName, scope: e.scope, dueDate: e.dueDate, status: e.status };
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
    if (!canAccessAudit(auth.membership)) return NextResponse.json({ error: "You don't have audit access." }, { status: 403 });

    const examinations = await listExaminations(orgId, { status: searchParams.get("status") || undefined });
    return NextResponse.json({ examinations: examinations.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/examinations GET failed:", err);
    return NextResponse.json({ error: "Could not fetch examinations." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, examinerOrgName } = body;
    if (!orgId || !examinerOrgName) return NextResponse.json({ error: "orgId and examinerOrgName are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createExamination({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ examination: serialize(result.examination) });
  } catch (err) {
    console.error("orgs/regulated/examinations POST failed:", err);
    return NextResponse.json({ error: "Could not create examination." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, examinationId, action } = await req.json();
    if (!orgId || !examinationId || !action) return NextResponse.json({ error: "orgId, examinationId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionExamination({ orgId, examinationId, action, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ examination: serialize(result.examination) });
  } catch (err) {
    console.error("orgs/regulated/examinations PATCH failed:", err);
    return NextResponse.json({ error: "Could not update examination." }, { status: 500 });
  }
}
