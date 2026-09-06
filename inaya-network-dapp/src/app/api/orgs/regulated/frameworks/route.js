// app/api/orgs/regulated/frameworks/route.js
// GET  ?orgId= -> list the static reference catalog + this org's enabled framework IDs
// PATCH { orgId, frameworkIds } -> set which frameworks this org has adopted

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { listFrameworks, getOrgEnabledFrameworks, setOrgEnabledFrameworks, REFERENCE_DISCLAIMER } from "../../../../../lib/compliance-frameworks.js";

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

    const [frameworks, enabledFrameworkIds] = await Promise.all([listFrameworks(), getOrgEnabledFrameworks(orgId)]);
    return NextResponse.json({ frameworks, enabledFrameworkIds, disclaimer: REFERENCE_DISCLAIMER });
  } catch (err) {
    console.error("orgs/regulated/frameworks GET failed:", err);
    return NextResponse.json({ error: "Could not fetch frameworks." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, frameworkIds } = await req.json();
    if (!orgId || !Array.isArray(frameworkIds)) return NextResponse.json({ error: "orgId and frameworkIds are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await setOrgEnabledFrameworks({ orgId, frameworkIds, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/regulated/frameworks PATCH failed:", err);
    return NextResponse.json({ error: "Could not update enabled frameworks." }, { status: 500 });
  }
}
