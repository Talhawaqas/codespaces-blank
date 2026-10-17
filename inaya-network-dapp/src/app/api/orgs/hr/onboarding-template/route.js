// app/api/orgs/hr/onboarding-template/route.js
//
// GET /api/orgs/hr/onboarding-template?orgId=...   -> HR roles
// PUT /api/orgs/hr/onboarding-template  { orgId, items: [string] }  -> HR managers / owner / admin
//   The org's onboarding checklist template. Editing it affects employees
//   whose checklist is created afterwards, never existing checklists.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessHR, canManageHR } from "../../../../../lib/orgs.js";
import { getOnboardingTemplate, setOnboardingTemplate } from "../../../../../lib/hr-structure.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessHR(auth.membership)) return NextResponse.json({ error: "Only HR can view the onboarding template." }, { status: 403 });
    return NextResponse.json(await getOnboardingTemplate(orgId));
  } catch (err) {
    console.error("orgs/hr/onboarding-template GET failed:", err);
    return NextResponse.json({ error: "Could not load the onboarding template." }, { status: 500 });
  }
}

export async function PUT(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { orgId, items } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageHR(auth.membership)) return NextResponse.json({ error: "Only an HR Manager or an owner/admin can edit the onboarding template." }, { status: 403 });
    const result = await setOnboardingTemplate({ orgId, items, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/hr/onboarding-template PUT failed:", err);
    return NextResponse.json({ error: "Could not save the onboarding template." }, { status: 500 });
  }
}
