// app/api/orgs/financial/theses/[thesisId]/revise/route.js
// POST { orgId, updates? } -> the only way to change a non-DRAFT thesis's content: creates a
// new DRAFT version (v+1). The revised thesis's content is never mutated.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { reviseThesis } from "../../../../../../../lib/investment-thesis.js";

function serialize(t) {
  return { id: t._id.toString(), key: t.key, version: t.version, status: t.status, supersedes: t.supersedes?.toString() || null };
}

export async function POST(req, { params }) {
  try {
    const { thesisId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await reviseThesis({ orgId, thesisId, updates: body.updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ thesis: serialize(result.thesis) });
  } catch (err) {
    console.error("orgs/financial/theses/[thesisId]/revise POST failed:", err);
    return NextResponse.json({ error: "Could not revise thesis." }, { status: 500 });
  }
}
