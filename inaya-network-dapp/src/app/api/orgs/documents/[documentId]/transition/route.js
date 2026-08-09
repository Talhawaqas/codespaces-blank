// app/api/orgs/documents/[documentId]/transition/route.js
//
// POST /api/orgs/documents/:documentId/transition
// Body: { orgId, action, note? }
// action is one of: submit, startReview, approve, reject, revise, archive, restore
//
// The ONLY place document state changes happen — see
// src/lib/document-workflow.js for the actual state machine, role
// enforcement, org isolation, and atomicity/replay-safety. This route is
// intentionally thin: authenticate the session, hand off, translate the
// result to an HTTP response.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { transitionDocument } from "../../../../../../lib/document-workflow.js";

export async function POST(req, { params }) {
  try {
    const { documentId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) {
      return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionDocument({
      orgId,
      documentId,
      action,
      membership: auth.membership,
      actorEmail: auth.session.email,
      note,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({
      status: result.document.status,
      updatedAt: result.document.updatedAt,
    });
  } catch (err) {
    console.error("orgs/documents/[documentId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the document's status." }, { status: 500 });
  }
}
