// app/api/public/v1/data-sources/route.js
//
// Authorization: Bearer <apiKey>. GET -> list this org's data sources.
// This is the surface JDBC/ODBC drivers call (see
// terraform-provider-inaya/README.md and this SOW's docs for the same
// bearer-API-key convention every public/v1 route already uses --
// orgId always comes from the key, never the request).

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../lib/api-keys.js";
import { listDataSources } from "../../../../../lib/legacyDataAccess/dataSources.js";

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listDataSources({ orgId: auth.orgId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/data-sources GET failed:", err);
    return NextResponse.json({ error: "Could not list data sources." }, { status: 500 });
  }
}
