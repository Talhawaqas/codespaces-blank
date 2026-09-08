// app/api/orgs/trust-relationships/route.js
//
// POST /api/orgs/trust-relationships — propose a relationship FROM orgId
//      TO toOrgId. Body: { orgId, toOrgId, scope: string[], purpose?, expiresAt? }
// GET  /api/orgs/trust-relationships?orgId= — list every relationship
//      involving this org, in either direction.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { proposeTrustRelationship, listTrustRelationships } from "../../../../lib/org-trust.js";

export async function POST(req) {
  try {
    const { orgId, toOrgId, scope, purpose, expiresAt } = await req.json();
    if (!orgId || !toOrgId) return NextResponse.json({ error: "orgId and toOrgId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await proposeTrustRelationship({ fromOrgId: orgId, toOrgId, scope, purpose, expiresAt, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/trust-relationships POST failed:", err);
    return NextResponse.json({ error: "Could not propose the trust relationship." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listTrustRelationships({ orgId });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/trust-relationships GET failed:", err);
    return NextResponse.json({ error: "Could not list trust relationships." }, { status: 500 });
  }
}
