// app/api/orgs/regulated/policies/[policyId]/amend/route.js
// POST { orgId, title?, body? } -> the only way to change a PUBLISHED policy's content: creates a new
// DRAFT document at version+1 and marks the current one AMENDED. Never mutates the published row.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { amendPolicy } from "../../../../../../../lib/compliance-policies.js";

function serialize(p) {
  return { id: p._id.toString(), key: p.key, version: p.version, title: p.title, body: p.body, status: p.status, supersedes: p.supersedes?.toString() || null };
}

export async function POST(req, { params }) {
  try {
    const { policyId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await amendPolicy({ orgId, policyId, title: body.title, body: body.body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ policy: serialize(result.policy) });
  } catch (err) {
    console.error("orgs/regulated/policies/[policyId]/amend POST failed:", err);
    return NextResponse.json({ error: "Could not amend policy." }, { status: 500 });
  }
}
