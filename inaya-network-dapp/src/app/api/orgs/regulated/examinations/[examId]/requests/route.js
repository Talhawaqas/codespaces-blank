// app/api/orgs/regulated/examinations/[examId]/requests/route.js
// GET  ?orgId=&status= -> list evidence requests for this examination
// POST { orgId, description, dueDate?, ownerEmail? } -> create an evidence request

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAudit } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { createEvidenceRequest, listExaminationRequests } from "../../../../../../../lib/regulatory-examination.js";

function serialize(r) {
  return {
    id: r._id.toString(), examinationId: r.examinationId.toString(), description: r.description,
    dueDate: r.dueDate, ownerEmail: r.ownerEmail, status: r.status, response: r.response, reviewerComments: r.reviewerComments,
  };
}

export async function GET(req, { params }) {
  try {
    const { examId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    // Audit staff see every request in the examination; anyone else only
    // sees requests assigned to them (they need this to know what evidence
    // they've been asked to produce) — never the full examination scope.
    const isAuditor = canAccessAudit(auth.membership);
    const requests = await listExaminationRequests(orgId, examId, {
      status: searchParams.get("status") || undefined,
      ownerEmail: isAuditor ? undefined : auth.session.email,
    });
    return NextResponse.json({ requests: requests.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/examinations/[examId]/requests GET failed:", err);
    return NextResponse.json({ error: "Could not fetch requests." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { examId } = await params;
    const body = await req.json();
    const { orgId, description } = body;
    if (!orgId || !description) return NextResponse.json({ error: "orgId and description are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createEvidenceRequest({ orgId, examinationId: examId, description, dueDate: body.dueDate, ownerEmail: body.ownerEmail, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/regulated/examinations/[examId]/requests POST failed:", err);
    return NextResponse.json({ error: "Could not create evidence request." }, { status: 500 });
  }
}
