// app/api/orgs/regulated/controls/route.js
// GET  ?orgId=&status=&framework= -> list controls
// POST { orgId, name, description, objective, ownerEmail, reviewer, frequency, evidenceType, automationLevel } -> create control

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createControl, listControls } from "../../../../../lib/compliance-controls.js";

function serialize(c) {
  return {
    id: c._id.toString(), name: c.name, description: c.description, objective: c.objective,
    ownerEmail: c.ownerEmail, reviewer: c.reviewer, frequency: c.frequency, evidenceType: c.evidenceType,
    automationLevel: c.automationLevel, status: c.status, effectiveness: c.effectiveness,
    linkedRequirements: c.linkedRequirements, lastTestedAt: c.lastTestedAt, nextTestDueAt: c.nextTestDueAt,
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

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessCompliance(auth.membership)) return NextResponse.json({ error: "You don't have compliance access." }, { status: 403 });

    const controls = await listControls(orgId, { status: searchParams.get("status") || undefined, framework: searchParams.get("framework") || undefined });
    return NextResponse.json({ controls: controls.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/controls GET failed:", err);
    return NextResponse.json({ error: "Could not fetch controls." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name } = body;
    if (!orgId || !name) return NextResponse.json({ error: "orgId and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createControl({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ control: serialize(result.control) });
  } catch (err) {
    console.error("orgs/regulated/controls POST failed:", err);
    return NextResponse.json({ error: "Could not create control." }, { status: 500 });
  }
}
