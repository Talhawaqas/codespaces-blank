// app/api/orgs/api-keys/route.js
//
// POST /api/orgs/api-keys — body: { orgId, label? }. Returns the raw key
//      exactly once — the caller must store it themselves, nothing else
//      ever shows it again.
// GET  /api/orgs/api-keys?orgId= — list this org's keys (never the raw
//      value or the hash).
//
// Owner/admin only — an API key can drive the same public/v1 endpoints a
// signed-in owner/admin can, so issuing one gets the same gate as any
// other owner/admin-only action.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../lib/orgs.js";
import { createApiKey, listApiKeys } from "../../../../lib/api-keys.js";

export async function POST(req) {
  try {
    const { orgId, label } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can create an API key." }, { status: 403 });

    const result = await createApiKey({ orgId, label, actorEmail: auth.session.email });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/api-keys POST failed:", err);
    return NextResponse.json({ error: "Could not create the API key." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can view API keys." }, { status: 403 });

    const result = await listApiKeys({ orgId });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/api-keys GET failed:", err);
    return NextResponse.json({ error: "Could not list API keys." }, { status: 500 });
  }
}
