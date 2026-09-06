// app/api/orgs/private-capital/term-sheets/[termSheetId]/transition/route.js
// PATCH { orgId, action, note? } -> send / counter / accept / reject

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionTermSheet } from "../../../../../../../lib/term-sheet.js";

function serialize(t) {
  return { id: t._id.toString(), version: t.version, status: t.status };
}

export async function PATCH(req, { params }) {
  try {
    const { termSheetId } = await params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionTermSheet({ orgId, termSheetId, action, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ termSheet: serialize(result.termSheet) });
  } catch (err) {
    console.error("orgs/private-capital/term-sheets/[termSheetId]/transition PATCH failed:", err);
    return NextResponse.json({ error: "Could not update term sheet." }, { status: 500 });
  }
}
