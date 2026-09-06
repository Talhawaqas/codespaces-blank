// app/api/orgs/financial/positions/route.js
// GET  ?orgId=&portfolioId= -> list positions
// POST { orgId, portfolioId, security, ... } -> ingest a position (read-only ingestion, never live trading)
// PATCH { orgId, positionId, marketValue, valuationSource? } -> update a position's market value

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { ingestPosition, updatePositionMarketValue, listPositions } from "../../../../../lib/portfolio-management.js";

function serialize(p) {
  return {
    id: p._id.toString(), portfolioId: p.portfolioId.toString(), security: p.security, issuer: p.issuer,
    sector: p.sector, geography: p.geography, strategy: p.strategy, currency: p.currency,
    quantity: p.quantity, costBasis: p.costBasis, marketValue: p.marketValue, unrealizedPL: p.unrealizedPL,
    valuationSource: p.valuationSource, valuationTimestamp: p.valuationTimestamp,
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

    const positions = await listPositions(orgId, { portfolioId: searchParams.get("portfolioId") || undefined });
    return NextResponse.json({ positions: positions.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/positions GET failed:", err);
    return NextResponse.json({ error: "Could not fetch positions." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, portfolioId, security } = body;
    if (!orgId || !portfolioId || !security) return NextResponse.json({ error: "orgId, portfolioId, and security are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await ingestPosition({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ position: serialize(result.position) });
  } catch (err) {
    console.error("orgs/financial/positions POST failed:", err);
    return NextResponse.json({ error: "Could not ingest position." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, positionId, marketValue, valuationSource } = await req.json();
    if (!orgId || !positionId || typeof marketValue !== "number") return NextResponse.json({ error: "orgId, positionId, and a numeric marketValue are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await updatePositionMarketValue({ orgId, positionId, marketValue, valuationSource, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ position: serialize(result.position) });
  } catch (err) {
    console.error("orgs/financial/positions PATCH failed:", err);
    return NextResponse.json({ error: "Could not update position." }, { status: 500 });
  }
}
