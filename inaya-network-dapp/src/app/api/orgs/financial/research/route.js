// app/api/orgs/financial/research/route.js
// GET  ?orgId=&fundId=&type=&company= -> list research
// POST { orgId, type, ... } -> create a research record

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createResearch, listResearch } from "../../../../../lib/investment-research.js";

function serialize(r) {
  return {
    id: r._id.toString(), fundId: r.fundId?.toString() || null, type: r.type, source: r.source,
    analyst: r.analyst, sector: r.sector, company: r.company, strategy: r.strategy,
    confidence: r.confidence, sensitivity: r.sensitivity, uploaderEmail: r.uploaderEmail,
    createdAt: r.createdAt, annotations: r.annotations,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const research = await listResearch(orgId, { fundId: searchParams.get("fundId") || undefined, type: searchParams.get("type") || undefined, company: searchParams.get("company") || undefined });
    return NextResponse.json({ research: research.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/research GET failed:", err);
    return NextResponse.json({ error: "Could not fetch research." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, type } = body;
    if (!orgId || !type) return NextResponse.json({ error: "orgId and type are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createResearch({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ research: serialize(result.research) });
  } catch (err) {
    console.error("orgs/financial/research POST failed:", err);
    return NextResponse.json({ error: "Could not create research record." }, { status: 500 });
  }
}
