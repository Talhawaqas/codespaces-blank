// app/api/orgs/financial/theses/route.js
// GET  ?orgId=&status=&key= -> list theses
// POST { orgId, key, title, ... } -> draft a new thesis (v1)
// PATCH { orgId, thesisId, updates } -> edit a DRAFT thesis in place

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createThesis, updateThesisDraft, listTheses } from "../../../../../lib/investment-thesis.js";

function serialize(t) {
  return {
    id: t._id.toString(), key: t.key, version: t.version, supersedes: t.supersedes?.toString() || null,
    title: t.title, target: t.target, strategy: t.strategy, author: t.author, status: t.status,
    upside: t.upside, downside: t.downside, probability: t.probability, keyRisks: t.keyRisks,
    invalidationCriteria: t.invalidationCriteria, valuation: t.valuation,
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

    const theses = await listTheses(orgId, { status: searchParams.get("status") || undefined, key: searchParams.get("key") || undefined });
    return NextResponse.json({ theses: theses.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/theses GET failed:", err);
    return NextResponse.json({ error: "Could not fetch theses." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, key, title } = body;
    if (!orgId || !key || !title) return NextResponse.json({ error: "orgId, key, and title are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createThesis({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ thesis: serialize(result.thesis) });
  } catch (err) {
    console.error("orgs/financial/theses POST failed:", err);
    return NextResponse.json({ error: "Could not create thesis." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, thesisId, updates } = await req.json();
    if (!orgId || !thesisId) return NextResponse.json({ error: "orgId and thesisId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await updateThesisDraft({ orgId, thesisId, updates: updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ thesis: serialize(result.thesis) });
  } catch (err) {
    console.error("orgs/financial/theses PATCH failed:", err);
    return NextResponse.json({ error: "Could not update thesis." }, { status: 500 });
  }
}
