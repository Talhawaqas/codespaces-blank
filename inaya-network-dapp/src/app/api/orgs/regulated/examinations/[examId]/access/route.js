// app/api/orgs/regulated/examinations/[examId]/access/route.js
// POST   { orgId, examinerEmail, requestIds?, expiresInHours? } -> issue a scoped examiner magic link (canManageAudit only)
// DELETE { orgId, examinerEmail } -> immediately revoke that examiner's access

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { createExaminerMagicLink, revokeExaminerAccess } from "../../../../../../../lib/regulatory-examination-access.js";

export async function POST(req, { params }) {
  try {
    const { examId } = await params;
    const body = await req.json();
    const { orgId, examinerEmail } = body;
    if (!orgId || !examinerEmail) return NextResponse.json({ error: "orgId and examinerEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createExaminerMagicLink({ orgId, examinationId: examId, examinerEmail, requestIds: body.requestIds, expiresInHours: body.expiresInHours, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    // The raw token is only ever returned here, to the auditor issuing
    // access — it is never logged or stored anywhere in recoverable form
    // (only its hash is persisted), matching every other magic-link flow
    // in this app.
    return NextResponse.json({ token: result.token });
  } catch (err) {
    console.error("orgs/regulated/examinations/[examId]/access POST failed:", err);
    return NextResponse.json({ error: "Could not issue examiner access." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { examId } = await params;
    const { orgId, examinerEmail } = await req.json();
    if (!orgId || !examinerEmail) return NextResponse.json({ error: "orgId and examinerEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await revokeExaminerAccess({ orgId, examinationId: examId, examinerEmail, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/regulated/examinations/[examId]/access DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke examiner access." }, { status: 500 });
  }
}
