// app/api/public/v1/data-sources/[dataSourceId]/health/route.js
//
// Authorization: Bearer <apiKey>. GET -> a real, on-demand health check.
// Used by the JDBC driver's Connection.isValid()/Connection.isClosed()
// path rather than assuming a connection is alive.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { checkDataSourceHealth } from "../../../../../../../lib/legacyDataAccess/dataSources.js";

export async function GET(req, { params }) {
  try {
    const { dataSourceId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await checkDataSourceHealth({ orgId: auth.orgId, dataSourceId, membership: auth.membership });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/data-sources/[dataSourceId]/health GET failed:", err);
    return NextResponse.json({ error: "Health check failed." }, { status: 500 });
  }
}
