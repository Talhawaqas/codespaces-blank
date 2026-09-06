// app/api/orgs/private-capital/deals/[dealId]/diligence/route.js
// GET  ?orgId=&domain=&status= -> list diligence requests for a deal
// POST { orgId, domain, request, ownerEmail?, dueDate? } -> create a diligence request

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { createDiligenceRequest, listDiligenceRequests } from "../../../../../../../lib/due-diligence.js";

function serialize(r) {
  return {
    id: r._id.toString(), dealId: r.dealId.toString(), domain: r.domain, request: r.request,
    ownerEmail: r.ownerEmail, dueDate: r.dueDate, evidence: r.evidence, reviewerEmail: r.reviewerEmail,
    risk: r.risk, conclusion: r.conclusion, status: r.status,
  };
}

export async function GET(req, { params }) {
  try {
    const { dealId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const requests = await listDiligenceRequests(orgId, { dealId, domain: searchParams.get("domain") || undefined, status: searchParams.get("status") || undefined });
    return NextResponse.json({ requests: requests.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/diligence GET failed:", err);
    return NextResponse.json({ error: "Could not fetch diligence requests." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { dealId } = await params;
    const body = await req.json();
    const { orgId, domain, request } = body;
    if (!orgId || !domain || !request) return NextResponse.json({ error: "orgId, domain, and request are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createDiligenceRequest({ ...body, dealId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/diligence POST failed:", err);
    return NextResponse.json({ error: "Could not create diligence request." }, { status: 500 });
  }
}
