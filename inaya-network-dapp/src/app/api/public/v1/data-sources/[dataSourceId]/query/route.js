// app/api/public/v1/data-sources/[dataSourceId]/query/route.js
//
// Authorization: Bearer <apiKey>. POST { sql, maxRows?, timeoutMs? } ->
// execute a read-only SQL query. This is the real transport the JDBC and
// ODBC drivers call for SQLExecDirect/Statement.executeQuery -- see
// jdbc-driver/ and the ODBC driver notes in this SOW's completion report.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { executeVirtualQuery } from "../../../../../../../lib/legacyDataAccess/sqlGateway.js";

export async function POST(req, { params }) {
  try {
    const { dataSourceId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));
    const { sql, maxRows, timeoutMs } = body;
    if (!sql) return NextResponse.json({ error: "sql is required." }, { status: 400 });

    const result = await executeVirtualQuery({ orgId: auth.orgId, dataSourceId, sql, maxRows, timeoutMs, membership: auth.membership, actorEmail: "api-key-client" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/data-sources/[dataSourceId]/query POST failed:", err);
    return NextResponse.json({ error: "Query execution failed." }, { status: 500 });
  }
}
