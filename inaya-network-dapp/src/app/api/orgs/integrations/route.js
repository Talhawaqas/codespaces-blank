// app/api/orgs/integrations/route.js
// GET   ?orgId= -> list the full integration catalog merged with this org's connections
// POST  { orgId, providerId, ownerEmail, syncFrequencyHours } -> configure (or reconfigure) an integration

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { configureIntegration, getOrgIntegrations } from "../../../../lib/integrations.js";

function serialize(c) {
  return {
    id: c.id, name: c.name, category: c.category, authType: c.authType, syncDirection: c.syncDirection,
    status: c.status, ownerEmail: c.ownerEmail, lastSyncAt: c.lastSyncAt, nextSyncAt: c.nextSyncAt,
    errorCount: c.errorCount, recordsProcessedTotal: c.recordsProcessedTotal, mismatchCountTotal: c.mismatchCountTotal,
    credentialsStatus: c.credentialsStatus,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const integrations = await getOrgIntegrations(orgId);
    return NextResponse.json({ integrations: integrations.map(serialize) });
  } catch (err) {
    console.error("orgs/integrations GET failed:", err);
    return NextResponse.json({ error: "Could not fetch integrations." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, providerId } = body;
    if (!orgId || !providerId) return NextResponse.json({ error: "orgId and providerId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await configureIntegration({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ connection: result.connection });
  } catch (err) {
    console.error("orgs/integrations POST failed:", err);
    return NextResponse.json({ error: "Could not configure integration." }, { status: 500 });
  }
}
