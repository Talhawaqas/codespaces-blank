// app/api/orgs/critical-functions/route.js
// GET   ?orgId= -> list critical business functions (§68 BIA records)
// POST  { orgId, name, ... } -> register a critical function
// PATCH { orgId, functionId, updates } -> update recovery objectives/procedures/contacts

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createCriticalFunction, updateCriticalFunction, listCriticalFunctions } from "../../../../lib/business-continuity.js";

function serialize(f) {
  return {
    id: f._id.toString(), name: f.name, description: f.description,
    recoveryTimeObjectiveHours: f.recoveryTimeObjectiveHours, recoveryPointObjectiveHours: f.recoveryPointObjectiveHours,
    dependencies: f.dependencies.map((id) => id.toString()), alternateProcedures: f.alternateProcedures,
    recoveryStrategy: f.recoveryStrategy, ownerEmail: f.ownerEmail, emergencyContacts: f.emergencyContacts,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const functions = await listCriticalFunctions(orgId);
    return NextResponse.json({ functions: functions.map(serialize) });
  } catch (err) {
    console.error("orgs/critical-functions GET failed:", err);
    return NextResponse.json({ error: "Could not fetch critical functions." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name } = body;
    if (!orgId || !name) return NextResponse.json({ error: "orgId and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createCriticalFunction({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ criticalFunction: serialize(result.criticalFunction) });
  } catch (err) {
    console.error("orgs/critical-functions POST failed:", err);
    return NextResponse.json({ error: "Could not create critical function." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, functionId, updates } = await req.json();
    if (!orgId || !functionId) return NextResponse.json({ error: "orgId and functionId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateCriticalFunction({ orgId, functionId, updates: updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ criticalFunction: serialize(result.criticalFunction) });
  } catch (err) {
    console.error("orgs/critical-functions PATCH failed:", err);
    return NextResponse.json({ error: "Could not update critical function." }, { status: 500 });
  }
}
