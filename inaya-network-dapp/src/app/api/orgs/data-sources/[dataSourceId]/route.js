// app/api/orgs/data-sources/[dataSourceId]/route.js
// GET ?orgId= -> detail; PATCH { orgId, action: "test" } -> re-test connection; DELETE { orgId } -> delete

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getDataSource, testDataSourceConnection, deleteDataSource } from "../../../../../lib/legacyDataAccess/dataSources.js";

export async function GET(req, { params }) {
  try {
    const { dataSourceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getDataSource({ orgId, dataSourceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources/[dataSourceId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch data source." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { dataSourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    if (action !== "test") return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    const result = await testDataSourceConnection({ orgId, dataSourceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources/[dataSourceId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not test data source connection." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { dataSourceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteDataSource({ orgId, dataSourceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-sources/[dataSourceId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete data source." }, { status: 500 });
  }
}
