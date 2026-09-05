// app/api/orgs/legal/holds/route.js
// GET   ?orgId=&status= -> list legal holds
// POST  { orgId, matterId, scope, custodianEmails, reason } -> create a hold
// PATCH { orgId, holdId, action:"acknowledge"|"release"|"exception", ... } -> advance

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createLegalHold, acknowledgeLegalHold, recordHoldException, releaseLegalHold, listLegalHolds } from "../../../../../lib/legal-hold-workflow.js";

function serialize(h) {
  return { id: h._id.toString(), scope: h.scope, matterId: h.matterId?.toString() || null, status: h.status, reason: h.reason, createdAt: h.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const holds = await listLegalHolds(orgId, { status });
    return NextResponse.json({ holds: holds.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/holds GET failed:", err);
    return NextResponse.json({ error: "Could not fetch legal holds." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.scope) return NextResponse.json({ error: "orgId and scope are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createLegalHold({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ hold: serialize(result.hold) });
  } catch (err) {
    console.error("orgs/legal/holds POST failed:", err);
    return NextResponse.json({ error: "Could not create legal hold." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const body = await req.json();
    const { orgId, holdId, action } = body;
    if (!orgId || !holdId || !action) return NextResponse.json({ error: "orgId, holdId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let result;
    if (action === "acknowledge") {
      result = await acknowledgeLegalHold({ orgId, holdId, actorEmail: auth.session.email });
    } else if (action === "exception") {
      result = await recordHoldException({ orgId, holdId, description: body.description, approvedByEmail: auth.session.email, actorEmail: auth.session.email, membership: auth.membership });
    } else if (action === "release") {
      result = await releaseLegalHold({ orgId, holdId, actorEmail: auth.session.email, membership: auth.membership });
    } else {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ hold: serialize(result.hold) });
  } catch (err) {
    console.error("orgs/legal/holds PATCH failed:", err);
    return NextResponse.json({ error: "Could not update legal hold." }, { status: 500 });
  }
}
