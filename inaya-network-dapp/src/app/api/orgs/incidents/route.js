// app/api/orgs/incidents/route.js
// GET   ?orgId=&status= -> list incidents
// POST  { orgId, category, severity, description, ... } -> report
// PATCH { orgId, incidentId, action } -> transition (contain/investigate/resolve/close/reopen)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createIncident, transitionIncident, listIncidents } from "../../../../lib/incidents.js";

function serialize(i) {
  return { id: i._id.toString(), category: i.category, severity: i.severity, status: i.status, description: i.description, createdAt: i.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const incidents = await listIncidents(orgId, { status });
    return NextResponse.json({ incidents: incidents.map(serialize) });
  } catch (err) {
    console.error("orgs/incidents GET failed:", err);
    return NextResponse.json({ error: "Could not fetch incidents." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.category || !body.severity) return NextResponse.json({ error: "orgId, category, and severity are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createIncident({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ incident: serialize(result.incident) });
  } catch (err) {
    console.error("orgs/incidents POST failed:", err);
    return NextResponse.json({ error: "Could not report incident." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, incidentId, action } = await req.json();
    if (!orgId || !incidentId || !action) return NextResponse.json({ error: "orgId, incidentId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionIncident({ orgId, incidentId, action, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ incident: serialize(result.incident) });
  } catch (err) {
    console.error("orgs/incidents PATCH failed:", err);
    return NextResponse.json({ error: "Could not update incident." }, { status: 500 });
  }
}
