// app/api/orgs/financial/funds/[fundId]/route.js
// GET ?orgId= -> a single fund's detail (must be in caller's visible scope)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { getAccessibleScope } from "../../../../../../lib/document-permissions.js";
import { listFundTeam } from "../../../../../../lib/fund-registry.js";

function serialize(f) {
  return {
    id: f._id.toString(), legalName: f.legalName, shortName: f.shortName, fundType: f.fundType,
    structureType: f.structureType, domicile: f.domicile, jurisdiction: f.jurisdiction,
    baseCurrency: f.baseCurrency, status: f.status, strategy: f.strategy,
    administrator: f.administrator, auditor: f.auditor, legalCounsel: f.legalCounsel,
    custodian: f.custodian, primeBroker: f.primeBroker, valuationProvider: f.valuationProvider,
    reportingFrequency: f.reportingFrequency,
  };
}

export async function GET(req, { params }) {
  try {
    const { fundId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const fund = scope.visibleFunds.find((f) => f._id.toString() === fundId);
    if (!fund) return NextResponse.json({ error: "Fund not found." }, { status: 404 });

    const team = await listFundTeam(orgId, fundId);
    return NextResponse.json({ fund: serialize(fund), team: team.map((t) => ({ email: t.email, role: t.role, assignedAt: t.assignedAt })) });
  } catch (err) {
    console.error("orgs/financial/funds/[fundId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch fund." }, { status: 500 });
  }
}
