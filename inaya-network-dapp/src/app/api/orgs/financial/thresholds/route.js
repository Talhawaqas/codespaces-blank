// app/api/orgs/financial/thresholds/route.js
// GET  ?orgId=&fundId= -> list configured thresholds for a fund
// POST { orgId, fundId, metric, limitValue } -> set/update a threshold
// PATCH { orgId, fundId, portfolioId } -> evaluate exposure against every threshold; a breach
//   creates a risk-register entry, an audit record, and a notification -- never just a UI flag

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { setThreshold, listThresholds, evaluateThresholds } from "../../../../../lib/portfolio-management.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const fundId = searchParams.get("fundId");
    if (!orgId || !fundId) return NextResponse.json({ error: "orgId and fundId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const thresholds = await listThresholds(orgId, fundId);
    return NextResponse.json({ thresholds: thresholds.map((t) => ({ metric: t.metric, limitValue: t.limitValue })) });
  } catch (err) {
    console.error("orgs/financial/thresholds GET failed:", err);
    return NextResponse.json({ error: "Could not fetch thresholds." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, fundId, metric, limitValue } = body;
    if (!orgId || !fundId || !metric || typeof limitValue !== "number") return NextResponse.json({ error: "orgId, fundId, metric, and a numeric limitValue are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await setThreshold({ orgId, fundId, metric, limitValue, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/financial/thresholds POST failed:", err);
    return NextResponse.json({ error: "Could not set threshold." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, fundId, portfolioId } = await req.json();
    if (!orgId || !fundId) return NextResponse.json({ error: "orgId and fundId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await evaluateThresholds({ orgId, fundId, portfolioId, actorEmail: auth.session.email, membership: auth.membership });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/financial/thresholds PATCH failed:", err);
    return NextResponse.json({ error: "Could not evaluate thresholds." }, { status: 500 });
  }
}
