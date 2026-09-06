// app/api/orgs/private-capital/portfolio-companies/[portfolioCompanyId]/cap-table/route.js
// GET  ?orgId= -> list cap-table snapshots (most recent first) for this company
// POST { orgId, asOfDate?, source?, rows } -> record a NEW immutable snapshot version

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordCapTableSnapshot, listCapTableSnapshots } from "../../../../../../../lib/cap-table.js";

function serialize(s) {
  return { id: s._id.toString(), version: s.version, asOfDate: s.asOfDate, source: s.source, rows: s.rows, totalFullyDilutedShares: s.totalFullyDilutedShares, recordedByEmail: s.recordedByEmail, approvedByEmail: s.approvedByEmail, approvedAt: s.approvedAt };
}

export async function GET(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const snapshots = await listCapTableSnapshots(orgId, portfolioCompanyId);
    return NextResponse.json({ snapshots: snapshots.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/cap-table GET failed:", err);
    return NextResponse.json({ error: "Could not fetch cap-table snapshots." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const body = await req.json();
    const { orgId, rows } = body;
    if (!orgId || !rows) return NextResponse.json({ error: "orgId and rows are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordCapTableSnapshot({ ...body, portfolioCompanyId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ snapshot: serialize(result.snapshot) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/cap-table POST failed:", err);
    return NextResponse.json({ error: "Could not record cap-table snapshot." }, { status: 500 });
  }
}
