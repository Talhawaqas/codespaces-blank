// app/api/orgs/legal/prospects/route.js
// POST { orgId, name, ... } -> intake a prospective client
// PATCH { orgId, prospectId, decision:"engage"|"decline" } -> decide

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createProspect, decideProspectEngagement } from "../../../../../lib/legal-clients.js";

function serialize(p) {
  return { id: p._id.toString(), name: p.name, status: p.status, classification: p.classification, createdAt: p.createdAt };
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.name) return NextResponse.json({ error: "orgId and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createProspect({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ prospect: serialize(result.prospect) });
  } catch (err) {
    console.error("orgs/legal/prospects POST failed:", err);
    return NextResponse.json({ error: "Could not create prospect." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, prospectId, decision } = await req.json();
    if (!orgId || !prospectId || !decision) return NextResponse.json({ error: "orgId, prospectId, and decision are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await decideProspectEngagement({ orgId, prospectId, decision, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ prospect: serialize(result.prospect) });
  } catch (err) {
    console.error("orgs/legal/prospects PATCH failed:", err);
    return NextResponse.json({ error: "Could not decide on prospect." }, { status: 500 });
  }
}
