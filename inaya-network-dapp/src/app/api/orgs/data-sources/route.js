// app/api/orgs/data-sources/route.js
// GET ?orgId= -> list; POST { orgId, name, connectorType, credentials } -> register

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { registerDataSource, listDataSources } from "../../../../lib/legacyDataAccess/dataSources.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listDataSources({ orgId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources GET failed:", err);
    return NextResponse.json({ error: "Could not list data sources." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, name, connectorType, credentials } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await registerDataSource({ orgId, name, connectorType, credentials, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ dataSource: { ...result.dataSource, _id: result.dataSource._id.toString() } });
  } catch (err) {
    console.error("orgs/data-sources POST failed:", err);
    return NextResponse.json({ error: "Could not register data source." }, { status: 500 });
  }
}
