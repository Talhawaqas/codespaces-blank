// app/api/public/v1/data-sources/[dataSourceId]/metadata/route.js
//
// Authorization: Bearer <apiKey>. GET -> the latest published virtual
// schema's tables/columns -- this is what the JDBC driver's
// DatabaseMetaData.getTables()/getColumns() calls against.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { listVirtualTables } from "../../../../../../../lib/legacyDataAccess/metadata.js";

export async function GET(req, { params }) {
  try {
    const { dataSourceId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listVirtualTables({ orgId: auth.orgId, dataSourceId, membership: auth.membership });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/data-sources/[dataSourceId]/metadata GET failed:", err);
    return NextResponse.json({ error: "Could not fetch virtual schema." }, { status: 500 });
  }
}
