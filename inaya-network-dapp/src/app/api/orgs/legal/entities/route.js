// app/api/orgs/legal/entities/route.js
// GET  ?orgId= -> list corporate entities
// POST { orgId, name, jurisdiction, entityType, ... } -> create

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createEntity, listEntities } from "../../../../../lib/corporate-entities.js";

function serialize(e) {
  return { id: e._id.toString(), name: e.name, jurisdiction: e.jurisdiction, entityType: e.entityType, filingCount: e.annualFilings?.length || 0 };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const entities = await listEntities(orgId);
    return NextResponse.json({ entities: entities.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/entities GET failed:", err);
    return NextResponse.json({ error: "Could not fetch corporate entities." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.name) return NextResponse.json({ error: "orgId and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createEntity({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ entity: serialize(result.entity) });
  } catch (err) {
    console.error("orgs/legal/entities POST failed:", err);
    return NextResponse.json({ error: "Could not create corporate entity." }, { status: 500 });
  }
}
