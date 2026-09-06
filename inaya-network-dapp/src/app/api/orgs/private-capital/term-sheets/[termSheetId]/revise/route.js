// app/api/orgs/private-capital/term-sheets/[termSheetId]/revise/route.js
// POST { orgId, updates? } -> the only way to change a non-DRAFT term sheet's terms: creates a
// new DRAFT version (v+1). The revised term sheet's content is never mutated.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { reviseTermSheet } from "../../../../../../../lib/term-sheet.js";

function serialize(t) {
  return { id: t._id.toString(), version: t.version, status: t.status, supersedes: t.supersedes?.toString() || null };
}

export async function POST(req, { params }) {
  try {
    const { termSheetId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await reviseTermSheet({ orgId, termSheetId, updates: body.updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ termSheet: serialize(result.termSheet) });
  } catch (err) {
    console.error("orgs/private-capital/term-sheets/[termSheetId]/revise POST failed:", err);
    return NextResponse.json({ error: "Could not revise term sheet." }, { status: 500 });
  }
}
