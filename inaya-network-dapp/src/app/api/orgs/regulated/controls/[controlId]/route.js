// app/api/orgs/regulated/controls/[controlId]/route.js
// PATCH { orgId, updates } -> update a control's fields/status/effectiveness
// PATCH { orgId, action:"linkRequirement", frameworkId, requirementId } -> link a requirement

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { updateControl, linkControlToRequirement } from "../../../../../../lib/compliance-controls.js";

function serialize(c) {
  return {
    id: c._id.toString(), name: c.name, description: c.description, objective: c.objective,
    ownerEmail: c.ownerEmail, reviewer: c.reviewer, frequency: c.frequency, evidenceType: c.evidenceType,
    automationLevel: c.automationLevel, status: c.status, effectiveness: c.effectiveness,
    linkedRequirements: c.linkedRequirements, lastTestedAt: c.lastTestedAt, nextTestDueAt: c.nextTestDueAt,
  };
}

export async function PATCH(req, { params }) {
  try {
    const { controlId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    let result;
    if (action === "linkRequirement") {
      const { frameworkId, requirementId } = body;
      if (!frameworkId || !requirementId) return NextResponse.json({ error: "frameworkId and requirementId are required." }, { status: 400 });
      result = await linkControlToRequirement({ orgId, controlId, frameworkId, requirementId, actorEmail: auth.session.email, membership: auth.membership });
    } else {
      result = await updateControl({ orgId, controlId, updates: body.updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ control: serialize(result.control) });
  } catch (err) {
    console.error("orgs/regulated/controls/[controlId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update control." }, { status: 500 });
  }
}
