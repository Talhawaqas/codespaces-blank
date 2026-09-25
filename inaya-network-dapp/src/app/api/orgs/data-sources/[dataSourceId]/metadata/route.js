// app/api/orgs/data-sources/[dataSourceId]/metadata/route.js
// GET ?orgId= -> list virtual tables; POST { orgId } -> import + publish a new schema version

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { listVirtualTables, importAndPublishSchema } from "../../../../../../lib/legacyDataAccess/metadata.js";

export async function GET(req, { params }) {
  try {
    const { dataSourceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listVirtualTables({ orgId, dataSourceId, membership: auth.membership });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources/[dataSourceId]/metadata GET failed:", err);
    return NextResponse.json({ error: "Could not list virtual tables." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { dataSourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await importAndPublishSchema({ orgId, dataSourceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources/[dataSourceId]/metadata POST failed:", err);
    return NextResponse.json({ error: "Could not import/publish schema." }, { status: 500 });
  }
}
