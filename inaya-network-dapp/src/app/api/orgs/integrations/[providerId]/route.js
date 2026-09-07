// app/api/orgs/integrations/[providerId]/route.js
// GET   ?orgId= -> get one integration's health detail
// PATCH { orgId, action } -> action: "disable" | "retry"

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getIntegrationHealth, disableIntegration, retrySync } from "../../../../../lib/integrations.js";

export async function GET(req, { params }) {
  try {
    const { providerId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const health = await getIntegrationHealth(orgId, providerId);
    return NextResponse.json(health);
  } catch (err) {
    console.error("orgs/integrations/[providerId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch integration health." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { providerId } = await params;
    const { orgId, action } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const fn = { disable: disableIntegration, retry: retrySync }[action];
    if (!fn) return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    const result = await fn({ orgId, providerId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ connection: result.connection });
  } catch (err) {
    console.error("orgs/integrations/[providerId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update integration." }, { status: 500 });
  }
}
