// app/api/orgs/financial/valuations/route.js
// GET  ?orgId=&positionId= -> list valuations for a position (most recent first)
// POST { orgId, positionId, method, value, ... } -> record a new valuation (never edits a prior one)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { recordValuation, listValuations } from "../../../../../lib/valuation-management.js";

function serialize(v) {
  return {
    id: v._id.toString(), positionId: v.positionId.toString(), instrumentType: v.instrumentType,
    method: v.method, source: v.source, valuationDate: v.valuationDate, value: v.value, currency: v.currency,
    isOverride: v.isOverride, overrideReason: v.overrideReason, reviewerEmail: v.reviewerEmail, approvedAt: v.approvedAt,
    recordedByEmail: v.recordedByEmail,
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

    const valuations = await listValuations(orgId, { positionId: searchParams.get("positionId") || undefined });
    return NextResponse.json({ valuations: valuations.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/valuations GET failed:", err);
    return NextResponse.json({ error: "Could not fetch valuations." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, positionId, method, value } = body;
    if (!orgId || !positionId || !method || typeof value !== "number") return NextResponse.json({ error: "orgId, positionId, method, and a numeric value are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordValuation({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ valuation: serialize(result.valuation) });
  } catch (err) {
    console.error("orgs/financial/valuations POST failed:", err);
    return NextResponse.json({ error: "Could not record valuation." }, { status: 500 });
  }
}
