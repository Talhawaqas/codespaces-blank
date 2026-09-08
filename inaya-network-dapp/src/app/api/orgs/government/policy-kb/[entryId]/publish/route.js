// app/api/orgs/government/policy-kb/[entryId]/publish/route.js
// POST { orgId, effectiveDate, expiresAt } -> publish an APPROVED entry (immutable from this point on)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { publishEntry } from "../../../../../../../lib/policy-knowledge-base.js";

export async function POST(req, { params }) {
  try {
    const { entryId } = params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await publishEntry({ orgId, entryId, effectiveDate: body.effectiveDate, expiresAt: body.expiresAt, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ entry: result.entry });
  } catch (err) {
    console.error("orgs/government/policy-kb/[entryId]/publish POST failed:", err);
    return NextResponse.json({ error: "Could not publish the entry." }, { status: 500 });
  }
}
