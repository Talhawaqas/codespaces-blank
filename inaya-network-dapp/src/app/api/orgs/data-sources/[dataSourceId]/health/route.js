// app/api/orgs/data-sources/[dataSourceId]/health/route.js
// GET ?orgId= -> real, on-demand health check against the live connector

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { checkDataSourceHealth } from "../../../../../../lib/legacyDataAccess/dataSources.js";

export async function GET(req, { params }) {
  try {
    const { dataSourceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await checkDataSourceHealth({ orgId, dataSourceId, membership: auth.membership });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources/[dataSourceId]/health GET failed:", err);
    return NextResponse.json({ error: "Health check failed." }, { status: 500 });
  }
}
