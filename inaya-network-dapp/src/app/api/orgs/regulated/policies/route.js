// app/api/orgs/regulated/policies/route.js
// GET  ?orgId=&status=&key= -> list policies
// POST { orgId, key, title, body, ownerEmail, reviewCycleDays } -> author a new policy draft (v1)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createPolicyDraft, listPolicies } from "../../../../../lib/compliance-policies.js";

function serialize(p) {
  return {
    id: p._id.toString(), key: p.key, version: p.version, title: p.title, body: p.body,
    ownerEmail: p.ownerEmail, status: p.status, immutable: p.immutable, effectiveDate: p.effectiveDate,
    expiresAt: p.expiresAt, supersedes: p.supersedes?.toString() || null, approvedByEmail: p.approvedByEmail,
  };
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

    // Any org member can see PUBLISHED policies (they're the ones being
    // asked to acknowledge them) — only compliance staff can see policies
    // still in draft/review/approval. A non-compliance member's requested
    // status filter is overridden, never trusted, to prevent peeking at
    // an unpublished policy by just asking for status=DRAFT.
    const requestedStatus = searchParams.get("status") || undefined;
    const status = canAccessCompliance(auth.membership) ? requestedStatus : "PUBLISHED";
    const policies = await listPolicies(orgId, { status, key: searchParams.get("key") || undefined });
    return NextResponse.json({ policies: policies.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/policies GET failed:", err);
    return NextResponse.json({ error: "Could not fetch policies." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, key, title } = body;
    if (!orgId || !key || !title) return NextResponse.json({ error: "orgId, key, and title are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createPolicyDraft({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ policy: serialize(result.policy) });
  } catch (err) {
    console.error("orgs/regulated/policies POST failed:", err);
    return NextResponse.json({ error: "Could not create policy." }, { status: 500 });
  }
}
