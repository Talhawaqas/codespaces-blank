// app/api/orgs/financial/entities/route.js
// GET  ?orgId=&type= -> list financial entities
// POST { orgId, type, name, parentEntityId?, details? } -> create an entity

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createEntity, listEntities } from "../../../../../lib/financial-entities.js";

function serialize(e) {
  return { id: e._id.toString(), type: e.type, name: e.name, parentEntityId: e.parentEntityId?.toString() || null, details: e.details, status: e.status };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const entities = await listEntities(orgId, { type: searchParams.get("type") || undefined });
    return NextResponse.json({ entities: entities.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/entities GET failed:", err);
    return NextResponse.json({ error: "Could not fetch entities." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, type, name } = body;
    if (!orgId || !type || !name) return NextResponse.json({ error: "orgId, type, and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createEntity({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ entity: serialize(result.entity) });
  } catch (err) {
    console.error("orgs/financial/entities POST failed:", err);
    return NextResponse.json({ error: "Could not create entity." }, { status: 500 });
  }
}
