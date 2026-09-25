// app/api/orgs/data-sources/[dataSourceId]/query/route.js
// POST { orgId, sql, maxRows?, timeoutMs? } -> execute a read-only SQL query against the virtualized schema

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { executeVirtualQuery } from "../../../../../../lib/legacyDataAccess/sqlGateway.js";

export async function POST(req, { params }) {
  try {
    const { dataSourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, sql, maxRows, timeoutMs } = body;
    if (!orgId || !sql) return NextResponse.json({ error: "orgId and sql are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await executeVirtualQuery({ orgId, dataSourceId, sql, maxRows, timeoutMs, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources/[dataSourceId]/query POST failed:", err);
    return NextResponse.json({ error: "Query execution failed." }, { status: 500 });
  }
}
